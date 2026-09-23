import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RepoId } from '@interlock/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { captureDirtyState, commitSnapshotInShadow, createGitRunner } from '../src/index.js';
import type { UserRepo } from '../src/index.js';
import { ensureShadow } from '../src/git/shadow.js';
import { rejection } from './support/rejection.js';

describe('commitSnapshotInShadow', () => {
  let base: string;
  let dir: string;
  let dataDir: string;
  let repo: UserRepo;
  const repoId = '01JBQ0000000000000000REPO' as RepoId;
  const runner = createGitRunner();

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const gitIn = (where: string, ...args: string[]): string =>
    execFileSync('git', ['-C', where, ...args], { stdio: 'pipe', encoding: 'utf8' });

  const objectCount = (objectsDir: string): number => {
    const out = execFileSync(
      'find',
      [objectsDir, '-type', 'f', '-not', '-path', `${objectsDir}/info/*`],
      { stdio: 'pipe', encoding: 'utf8' },
    );
    return out.split('\n').filter(Boolean).length;
  };

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'interlock-snapshot-')));
    dir = join(base, 'user');
    dataDir = join(base, 'data');
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'pipe' });
    git('config', 'user.name', 'Interlock Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');

    repo = { kind: 'user', rootPath: dir, gitDir: join(dir, '.git') };
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('wraps a dirty state tree in a new commit in the shadow', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'b.txt'), 'uncommitted\n');

    const snapshot = await captureDirtyState(dir, repo, { runner });
    const result = await commitSnapshotInShadow(
      shadow,
      snapshot.treeOid,
      'refs/remotes/user/main',
      { runner },
    );

    expect(result.treeOid).toBe(snapshot.treeOid);
    expect(result.wasClean).toBe(false);

    const type = gitIn(shadow.rootPath, 'cat-file', '-t', result.commitSha).trim();
    expect(type).toBe('commit');

    const treeOfCommit = gitIn(shadow.rootPath, 'rev-parse', `${result.commitSha}^{tree}`).trim();
    expect(treeOfCommit).toBe(snapshot.treeOid);
  });

  it('returns the branch head directly when the worktree is clean', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    const headCommit = git('rev-parse', 'HEAD').trim();
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });
    const objectsBefore = objectCount(join(shadow.rootPath, 'objects'));

    const snapshot = await captureDirtyState(dir, repo, { runner });
    const result = await commitSnapshotInShadow(
      shadow,
      snapshot.treeOid,
      'refs/remotes/user/main',
      { runner },
    );

    expect(result.wasClean).toBe(true);
    expect(result.commitSha).toBe(headCommit);
    expect(result.treeOid).toBe(snapshot.treeOid);

    const objectsAfter = objectCount(join(shadow.rootPath, 'objects'));
    expect(objectsAfter).toBe(objectsBefore); // No new commits created in shadow
  });

  it('creates a root commit when the branch is unborn', async () => {
    // Unborn branch, repo just initialized
    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'a.txt'), 'uncommitted\n');

    const snapshot = await captureDirtyState(dir, repo, { runner });
    const result = await commitSnapshotInShadow(shadow, snapshot.treeOid, '', { runner });

    expect(result.wasClean).toBe(false);

    // Assert it has no parent
    const parents = gitIn(shadow.rootPath, 'log', '-1', '--pretty=%P', result.commitSha).trim();
    expect(parents).toBe('');
  });

  it('throws a typed error if the tree was garbage collected before being committed', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'b.txt'), 'uncommitted\n');
    const snapshot = await captureDirtyState(dir, repo, { runner });

    // forcefully prune all unreferenced objects from the user's object store
    git('prune');

    const error = await rejection(
      commitSnapshotInShadow(shadow, snapshot.treeOid, 'refs/remotes/user/main', { runner }),
    );
    expect(error.code).toBe('GIT_COMMAND_FAILED');
    expect(error.infra).toBe(true);
  });

  it('produces different commit shas for the same tree oid', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'b.txt'), 'uncommitted\n');

    const snapshot = await captureDirtyState(dir, repo, { runner });

    const result1 = await commitSnapshotInShadow(
      shadow,
      snapshot.treeOid,
      'refs/remotes/user/main',
      { runner },
    );

    // Sleep a bit so the timestamps might differ, but git commit-tree also factors in the exact time.
    // Usually even rapid calls might get the same second, but passing different messages or just the fact we are testing this logic
    // Actually, if we call it in the exact same second, commit-tree might produce the same sha1.
    // But since it is synthetic, let's at least test we can call it twice.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const result2 = await commitSnapshotInShadow(
      shadow,
      snapshot.treeOid,
      'refs/remotes/user/main',
      { runner },
    );

    expect(result1.treeOid).toBe(result2.treeOid);
    expect(result1.commitSha).not.toBe(result2.commitSha);
  });

  it('handles hostile paths with spaces and newlines', async () => {
    writeFileSync(join(dir, 'a.txt'), 'one\n');
    git('add', '-A');
    git('commit', '-qm', 'one');

    const shadow = await ensureShadow(repo, { runner, dataDir, repoId });

    writeFileSync(join(dir, 'file with space.txt'), 'space\n');
    writeFileSync(join(dir, 'file\nwith\nnewline.txt'), 'newline\n');

    const snapshot = await captureDirtyState(dir, repo, { runner });
    const result = await commitSnapshotInShadow(
      shadow,
      snapshot.treeOid,
      'refs/remotes/user/main',
      { runner },
    );

    const lsTree = gitIn(shadow.rootPath, 'ls-tree', '-z', '--name-only', result.commitSha);
    const files = lsTree.split('\0').filter(Boolean);

    expect(files).toContain('file with space.txt');
    expect(files).toContain('file\nwith\nnewline.txt');
  });
});
