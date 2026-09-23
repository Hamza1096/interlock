import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { InterlockError } from '@interlock/shared';
import { assertObjectId, runRequired } from './repo-handle.js';
import type { GitRunner, ShadowRepo, UserRepo } from './repo-handle.js';
import { parseStatus } from './status.js';

/**
 * Working-tree observation and snapshotting.
 *
 * The subtle part is capturing a dirty worktree without touching the user's
 * index or stash: point `GIT_INDEX_FILE` at a temporary index outside the
 * repository, populate that, then `write-tree`. Objects land in the user's
 * object database, which is append-only and reclaimed by `git gc`; the index,
 * refs and stash are never written.
 */

/**
 * Ceiling on the pathspec bytes handed to one `git add`.
 *
 * Arguments and environment share a fixed budget per process, and a watcher
 * that reports thousands of paths would exceed it. The runner closes stdin, so
 * a long list is split across invocations against the same temporary index
 * rather than piped.
 *
 * It counts the paths alone. The runner's own arguments and the inherited
 * environment share the same budget, which is why the figure sits well under
 * any real limit rather than at it — on POSIX. Windows caps a command line near
 * 32 KB, so a port revisits this number rather than discovering it.
 */
export const MAX_PATHSPEC_BYTES = 96 * 1024;

/**
 * What a capture is allowed to look at.
 *
 * Scoped is the common case and the cheap one, but it is only correct with the
 * tree it is extending: seeded from `HEAD` it would drop every uncommitted
 * change outside the reported paths, producing a tree that is wrong rather than
 * merely stale. Requiring the base tree in the same object makes that
 * impossible to express by accident.
 */
export type SnapshotScope =
  | { readonly kind: 'whole-tree' }
  | {
      readonly kind: 'scoped';
      /**
       * Every path that changed since `baseTreeOid` was taken, including both
       * halves of a rename: a pathspec narrows git's rename detection as well,
       * so a source that is not reported is never restaged and the tree keeps a
       * file that is no longer there. A watcher sees both, because both moved.
       */
      readonly paths: readonly string[];
      /** Tree of the previous snapshot of this worktree. */
      readonly baseTreeOid: string;
    };

export interface SnapshotOptions {
  readonly runner: GitRunner;
  /** Defaults to a whole-tree capture, which is always correct and never cheap. */
  readonly scope?: SnapshotScope;
  /**
   * Existing directory the temporary index is created under. Defaults to the
   * system temp directory, which on many machines is a small tmpfs — and the
   * index of a large repository is not small.
   */
  readonly tempDir?: string;
  /**
   * Write the snapshot's objects into this shadow rather than the repository.
   *
   * Without it the tree lands in the user's object database with nothing
   * referencing it, where their `gc --prune` can reap it — including after a
   * commit in the shadow has come to point at it. Anything that will be merged
   * has to be captured with it.
   */
  readonly objectStore?: ShadowRepo;
}

export interface WorktreeSnapshot {
  /** Tree recording the worktree as it stood, uncommitted work included. */
  readonly treeOid: string;
  /**
   * Whether the tree is the one `HEAD` records, meaning nothing is uncommitted.
   * Always false where `HEAD` is unborn: with nothing committed there is no
   * state for the worktree to match.
   */
  readonly clean: boolean;
  /**
   * The commit `HEAD` named when the capture began, or null where it is unborn.
   *
   * The tree is this commit plus the uncommitted work, so it is the only
   * correct parent for the tree: a branch that has moved since would make the
   * new commit's work look reverted. Recorded here because it cannot be
   * recovered later — by then `HEAD` may name something else.
   */
  readonly headSha: string | null;
  /**
   * How the capture was actually taken. A scoped request reports `whole-tree`
   * when its base tree was no longer reachable, which tells a caller holding a
   * chain of snapshots that this one restarts it.
   */
  readonly takenAs: SnapshotScope['kind'];
  readonly capturedAt: string;
}

/**
 * Capture the uncommitted state of a user worktree as a tree object.
 *
 * Read-only with respect to everything a user can lose. The only write is to
 * the object database, which is additive.
 *
 * A submodule is recorded as the gitlink its superproject holds, so uncommitted
 * work inside one is not part of this.
 *
 * Throwing is ordinary. A file reported by the watcher and deleted before it is
 * staged fails the capture, so a caller has to treat a thrown capture as
 * non-fatal and keep the base tree it already had — advancing the base on a
 * failure loses the interval, and treating the throw as fatal turns an editor
 * race into a crash.
 *
 * @param worktreePath the worktree to capture, which for a linked worktree is
 *        not `repo.rootPath`.
 * @param repo the repository that worktree belongs to. Its git directory is
 *        passed to the runner, which is where a redirected index is checked
 *        against it.
 */
export async function captureDirtyState(
  worktreePath: string,
  repo: UserRepo,
  options: SnapshotOptions,
): Promise<WorktreeSnapshot> {
  // The worktree is where the files are; the git directory is the main
  // repository's, so redirecting the index is checked against both.
  const worktree: UserRepo = { kind: 'user', rootPath: worktreePath, gitDir: repo.gitDir };
  const runner = intoStore(options.runner, options.objectStore);
  const scope = options.scope ?? { kind: 'whole-tree' };
  const tempDir = options.tempDir ?? tmpdir();

  // The tree is read off the commit rather than off `HEAD` a second time, so
  // the two describe one moment even if the branch moves in between.
  const headSha = await resolveTree(worktree, runner, 'HEAD^{commit}');
  const headTree =
    headSha === null ? null : await resolveTree(worktree, runner, `${headSha}^{tree}`);
  // Stamped when the tree is written rather than when the capture began: it
  // describes what was read, and reading takes time a watcher may care about.
  const asSnapshot = (treeOid: string, takenAs: SnapshotScope['kind']): WorktreeSnapshot => ({
    treeOid,
    clean: headTree !== null && treeOid === headTree,
    headSha,
    takenAs,
    capturedAt: new Date().toISOString(),
  });

  if (scope.kind === 'scoped') {
    // Objects are unreferenced until something points at them, so a user
    // running `git gc --prune=now` between snapshots can collect the tree this
    // capture means to extend. Losing the base is a reason to take a full
    // snapshot, not a reason to fail.
    assertObjectId(scope.baseTreeOid, 'baseTreeOid');
    assertInsideWorktree(scope.paths);
    const base = await resolveTree(worktree, runner, `${scope.baseTreeOid}^{tree}`);
    if (base !== null) {
      return asSnapshot(await extendTree(worktree, runner, tempDir, base, scope.paths), 'scoped');
    }
  }

  return asSnapshot(await buildTree(worktree, runner, tempDir, headTree), 'whole-tree');
}

/**
 * A runner whose every call uses one object store.
 *
 * A capture writes blobs, then a tree built from them, then may read that tree
 * back as the next capture's base; all of it has to happen in the same store,
 * or a later step looks for an object an earlier one put somewhere else.
 */
function intoStore(runner: GitRunner, objectStore: ShadowRepo | undefined): GitRunner {
  if (objectStore === undefined) return runner;
  return {
    run: (repo, args, runOptions = {}) => runner.run(repo, args, { ...runOptions, objectStore }),
  };
}

/**
 * Resolve a revision to an object id, or `null` when it does not resolve.
 *
 * `rev-parse --verify` answers with an exit code rather than a message, which
 * is what makes this usable as a test: git's wording for a missing object has
 * changed between versions and matching on it would be a version dependency.
 */
async function resolveTree(
  worktree: UserRepo,
  runner: GitRunner,
  revision: string,
): Promise<string | null> {
  const result = await runner.run(worktree, ['rev-parse', '--verify', '--quiet', revision]);
  if (result.exitCode !== 0) return null;
  const oid = result.stdout.trim();
  return oid === '' ? null : oid;
}

/**
 * Which of the reported paths differ from the tree being extended.
 *
 * Asked against `indexFile` rather than the user's index, which is what makes
 * the answer the right one. Against the user's index the question is "is this
 * path dirty relative to HEAD", and a file the user reverted answers no — so a
 * capture would hand back a base tree still holding the edit, which is a tree
 * that is wrong rather than merely stale. Against an index seeded from the base
 * tree the question is "does this path differ from what I already recorded",
 * which is the one the scoped path has.
 *
 * The filter earns its place twice over: `git add` refuses a path it is told to
 * add that is ignored, and fails outright on one matching nothing — a file
 * created and deleted inside a debounce window. Both are ordinary watcher
 * output, and `status` reports neither.
 *
 * It closes the window rather than eliminating it: a file deleted between this
 * answer and the staging that follows is reported and then gone. The next
 * watcher event captures the deletion, so the cost is one failed capture rather
 * than a wrong tree.
 */
async function changedPaths(
  worktree: UserRepo,
  runner: GitRunner,
  indexFile: string,
  paths: readonly string[],
): Promise<string[]> {
  const reported = new Set<string>();

  for (const chunk of chunkPaths(paths)) {
    const status = await runRequired(
      runner,
      worktree,
      ['status', '--porcelain', '-z', '--untracked-files=all', '--', ...chunk],
      { indexFile },
    );
    for (const entry of parseStatus(status.stdout)) {
      // The worktree column alone. The index column compares the seeded index
      // against HEAD, which says how the base tree already differs from the
      // last commit — a path deleted in an earlier batch reports `D` there
      // forever, and restaging it finds nothing on disk and nothing in the
      // index, which `git add` treats as fatal.
      //
      // A rename's source needs no special handling for the same reason: git
      // reports it as a deletion in this column and its destination as
      // untracked, so both arrive on their own account.
      if (entry.worktree === ' ') continue;
      reported.add(entry.path);
      // Scoped to the worktree column: an index-column rename names a source
      // that is already absorbed into the base tree and no longer on disk,
      // which is the case the column filter exists to drop.
      if ((entry.worktree === 'R' || entry.worktree === 'C') && entry.origPath !== null) {
        reported.add(entry.origPath);
      }
    }
  }

  return [...reported];
}

/**
 * Paths are relative to the worktree, and a path that escapes it is a caller
 * bug rather than something to work around.
 *
 * Filtering one out silently would leave a snapshot quietly missing whatever
 * the caller meant by it; passing it through fails the capture with an error
 * about git. Neither says what actually went wrong.
 */
function assertInsideWorktree(paths: readonly string[]): void {
  for (const path of paths) {
    // `''` and `.` both normalise to the worktree root, which git reads as
    // every path in it — a scoped capture that quietly became a whole-tree one.
    if (path === '' || normalize(path) === '.') {
      throw new InterlockError('GIT_COMMAND_REFUSED', 'Snapshot paths name a file that changed', {
        details: { path },
        remedy: 'Report each changed path relative to the worktree root.',
      });
    }

    const normalised = normalize(path);
    if (isAbsolute(normalised) || normalised === '..' || normalised.startsWith(`..${sep}`)) {
      throw new InterlockError(
        'GIT_COMMAND_REFUSED',
        'Snapshot paths are relative to the worktree, and this one leaves it',
        {
          details: { path },
          remedy: 'Report paths relative to the worktree root.',
        },
      );
    }
  }
}

/**
 * Extend a tree with whatever changed among the reported paths.
 *
 * The index is seeded before the paths are filtered, because the seeded index
 * is the thing the filter has to compare against.
 */
async function extendTree(
  worktree: UserRepo,
  runner: GitRunner,
  tempDir: string,
  baseTree: string,
  paths: readonly string[],
): Promise<string> {
  return withTemporaryIndex(tempDir, async (indexFile) => {
    await runRequired(runner, worktree, ['read-tree', baseTree], { indexFile });

    const changed = await changedPaths(worktree, runner, indexFile, paths);
    // Nothing reported differs from the tree already recorded, so that tree
    // still describes the worktree and there is nothing to write.
    if (changed.length === 0) return baseTree;

    for (const chunk of chunkPaths(changed)) {
      await runRequired(runner, worktree, ['add', '-A', '--', ...chunk], { indexFile });
    }
    return writeTree(worktree, runner, indexFile);
  });
}

/**
 * Populate a temporary index and write it out as a tree.
 *
 * The seed is not optional: staging a handful of paths into an empty index
 * produces a tree holding only those paths, which is a corrupt snapshot rather
 * than a slow one. Seeding from `HEAD` also keeps a file that is tracked
 * despite matching `.gitignore`, which a rebuild from the worktree alone would
 * drop.
 */
async function buildTree(
  worktree: UserRepo,
  runner: GitRunner,
  tempDir: string,
  seedTree: string | null,
): Promise<string> {
  return withTemporaryIndex(tempDir, async (indexFile) => {
    await runRequired(
      runner,
      worktree,
      seedTree === null ? ['read-tree', '--empty'] : ['read-tree', seedTree],
      { indexFile },
    );
    await runRequired(runner, worktree, ['add', '-A'], { indexFile });
    return writeTree(worktree, runner, indexFile);
  });
}

async function writeTree(
  worktree: UserRepo,
  runner: GitRunner,
  indexFile: string,
): Promise<string> {
  const tree = await runRequired(runner, worktree, ['write-tree'], { indexFile });
  return tree.stdout.trim();
}

/**
 * Run something against an index that exists only for the duration.
 *
 * The directory is created first so the file has an existing parent: the runner
 * resolves the path through `realpath` and refuses one it cannot verify.
 */
async function withTemporaryIndex<T>(
  root: string,
  use: (indexFile: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(root, 'interlock-index-'));
  try {
    return await use(join(directory, 'index'));
  } finally {
    // The error path too: a temporary index left behind is a file in the user's
    // temp directory that nothing will ever clean up. A failure to remove it is
    // not worth replacing the diagnostic that brought us here.
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Split paths into groups that fit in one command line.
 *
 * Never yields an empty group: `git add -A --` with no pathspec stages the
 * whole worktree, so an empty chunk would quietly widen a scoped capture. A
 * single path over the ceiling goes alone rather than being dropped.
 */
export function* chunkPaths(paths: readonly string[]): Generator<string[]> {
  let chunk: string[] = [];
  let bytes = 0;

  for (const path of paths) {
    const size = Buffer.byteLength(path, 'utf8') + 1;
    if (chunk.length > 0 && bytes + size > MAX_PATHSPEC_BYTES) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }

  if (chunk.length > 0) yield chunk;
}

/**
 * The result of committing a dirty-state snapshot into the shadow clone.
 *
 * `treeOid` is the content identity — it is the key the scheduler uses for
 * deduplication. The same worktree state committed twice at different times
 * produces two different `commitSha` values but one `treeOid`, so the
 * scheduler must key on `treeOid`, not `commitSha`.
 *
 * `commitSha` is the object the speculative merger takes as an argument.
 * It always refers to a commit inside the shadow, never the user repo.
 */
export interface SnapshotCommit {
  /** Tree OID from `captureDirtyState` — content identity used for scheduling. */
  readonly treeOid: string;
  /** Commit SHA inside the shadow — the input to `speculativeMerge`. */
  readonly commitSha: string;
  /**
   * True when the snapshot tree matched the branch HEAD exactly.
   * No new commit was created; `commitSha` is the HEAD commit itself.
   * Lets the scheduler detect that a worktree has not changed without
   * comparing tree OIDs independently.
   */
  readonly wasClean: boolean;
}

/**
 * Materialise a snapshot as a commit **in the shadow repo only**, so the
 * speculative merge has two real commits to work with.
 *
 * Object-visibility design: snapshot trees are written into the user's object
 * database by `captureDirtyState` and are unreferenced there, so `git gc
 * --prune=now` can delete them between capture and merge. This function
 * verifies the tree is still reachable before committing it and surfaces a
 * missing tree as `OBJECT_NOT_FOUND` — a typed, retryable error. The caller
 * answers by re-running `captureDirtyState`. An alternative (writing the tree
 * directly into the shadow's object store) would require modifying
 * `captureDirtyState`, the most load-bearing function in the codebase.
 *
 * A clean snapshot (tree OID matches the branch HEAD's tree) returns the HEAD
 * commit directly without running `commit-tree`, because creating a new commit
 * for identical content would mislead the scheduler's change-detection logic.
 *
 * @param shadow  The shadow clone to commit into. Never the user repo.
 * @param snapshotTreeOid  A tree OID produced by `captureDirtyState`.
 * @param branchRef  The ref whose HEAD becomes the parent, e.g.
 *        `refs/remotes/user/main`. Pass the empty string for an unborn branch.
 * @param options.runner  The git runner for this operation.
 */
export async function commitSnapshotInShadow(
  shadow: ShadowRepo,
  snapshotTreeOid: string,
  branchRef: string,
  options: { readonly runner: GitRunner },
): Promise<SnapshotCommit> {
  const { runner } = options;

  assertObjectId(snapshotTreeOid, 'snapshotTreeOid');

  // Resolve the branch HEAD, if one exists.
  const headResult =
    branchRef === ''
      ? null
      : await runner.run(shadow, ['rev-parse', '--verify', '--quiet', branchRef]);
  const headCommit =
    headResult !== null && headResult.exitCode === 0 ? headResult.stdout.trim() || null : null;

  // A clean snapshot means the worktree matches the branch HEAD exactly.
  // Running commit-tree would create a new commit with identical content,
  // which would mislead the scheduler into thinking something changed.
  if (headCommit !== null) {
    const headTreeResult = await runner.run(shadow, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${headCommit}^{tree}`,
    ]);
    if (headTreeResult.exitCode === 0 && headTreeResult.stdout.trim() === snapshotTreeOid) {
      return { treeOid: snapshotTreeOid, commitSha: headCommit, wasClean: true };
    }
  }

  // Verify the tree is reachable in the shadow (via alternates from the user
  // repo). A user's `git gc` can delete unreferenced objects between the
  // snapshot and this call — that is the stated failure mode: OBJECT_NOT_FOUND
  // is retryable by re-snapshotting.
  const reachable = await runner.run(shadow, ['cat-file', '-e', snapshotTreeOid]);
  if (reachable.exitCode !== 0) {
    throw new InterlockError(
      'GIT_COMMAND_FAILED',
      'Snapshot tree was collected by gc before it could be committed into the shadow',
      {
        details: { treeOid: snapshotTreeOid },
        remedy: 'Re-run captureDirtyState to produce a fresh snapshot and try again.',
        infra: true,
      },
    );
  }

  // Build the commit-tree argument list. No parent flag when the branch is
  // unborn — that produces a root commit, which is correct for a new repo.
  const args = ['commit-tree', snapshotTreeOid];
  if (headCommit !== null) {
    args.push('-p', headCommit);
  }
  // The message is synthetic: this commit is never for human review.
  // It is deterministic given the tree OID so accidental duplicates are obvious
  // in the shadow's log, but the timestamp still differs so two calls are not
  // equal objects.
  args.push('-m', `interlock snapshot ${snapshotTreeOid.slice(0, 12)}`);

  const result = await runRequired(runner, shadow, args);
  const commitSha = result.stdout.trim();
  assertObjectId(commitSha, 'commitSha');

  return { treeOid: snapshotTreeOid, commitSha, wasClean: false };
}
