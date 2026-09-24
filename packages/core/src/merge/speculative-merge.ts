import { InterlockError } from '@interlock/shared';
import type { MergeOutcome } from '@interlock/shared';
import type { ShadowRepo, GitRunner } from '../git/repo-handle.js';

export interface SpeculativeMergeRequest {
  readonly shadow: ShadowRepo;
  readonly commitA: string;
  readonly commitB: string;
  readonly mergeBaseSha: string;
  readonly runner: GitRunner;
}

export interface SpeculativeMergeResult extends MergeOutcome {
  /** Stages of conflicted files, extracted directly from merge-tree output. */
  readonly conflictedStages: readonly ConflictedStage[];
  readonly durationMs: number;
}

export interface ConflictedStage {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly stage: number;
}

const writeTreeSupport = new WeakMap<ShadowRepo, boolean>();

async function checkWriteTreeCapability(runner: GitRunner, shadow: ShadowRepo): Promise<boolean> {
  const cached = writeTreeSupport.get(shadow);
  if (cached !== undefined) return cached;

  try {
    const result = await runner.run(shadow, ['merge-tree', '--write-tree']);
    const output = result.stdout + result.stderr;
    const supported = output.includes('--write-tree');
    writeTreeSupport.set(shadow, supported);
    return supported;
  } catch {
    return false;
  }
}

/**
 * Merge `commitB` into `commitA` inside a throwaway shadow worktree.
 *
 * A conflict is the result, not an error. This throws only when the merge could
 * not be attempted at all (`MERGE_FAILED`).
 */
export async function speculativeMerge(
  request: SpeculativeMergeRequest,
): Promise<SpeculativeMergeResult> {
  const { shadow, commitA, commitB, mergeBaseSha, runner } = request;

  const supported = await checkWriteTreeCapability(runner, shadow);
  if (!supported) {
    throw new InterlockError(
      'TOOLCHAIN_UNSUPPORTED',
      'git merge-tree --write-tree is not supported. Git 2.38+ is required.',
      { details: {}, remedy: 'Upgrade your git installation to 2.38 or later.', infra: true },
    );
  }

  const startedAt = Date.now();
  const args = ['merge-tree', '-z', '--write-tree', '--merge-base', mergeBaseSha, commitA, commitB];

  const result = await runner.run(shadow, args);

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new InterlockError('MERGE_FAILED', 'Speculative merge failed', {
      details: { stderr: result.stderr },
      remedy: 'Check if the commits are valid.',
      infra: false,
    });
  }

  const chunks = result.stdout.split('\0');

  // First chunk is always the merged tree OID
  const mergedTreeOid = chunks[0] ?? null;

  const conflictedStages: ConflictedStage[] = [];
  const conflictedPaths = new Set<string>();

  // After the tree OID, we have lines of conflicted files, ending with an empty string
  for (let i = 1; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined || chunk === '') {
      break; // End of conflicted files section
    }

    // Chunk format: "<mode> <oid> <stage>\t<path>"
    const tabIndex = chunk.indexOf('\t');
    if (tabIndex !== -1) {
      const metadata = chunk.substring(0, tabIndex);
      const path = chunk.substring(tabIndex + 1);
      const parts = metadata.split(' ');
      if (parts.length === 3) {
        conflictedStages.push({
          mode: parts[0]!,
          oid: parts[1]!,
          stage: parseInt(parts[2]!, 10),
          path,
        });
        conflictedPaths.add(path);
      }
    }
  }

  const durationMs = Date.now() - startedAt;

  return {
    clean: result.exitCode === 0,
    mergedTreeOid,
    conflictedPaths: Array.from(conflictedPaths),
    conflictedStages,
    durationMs,
  };
}
