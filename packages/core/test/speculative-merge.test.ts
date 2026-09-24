import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { test, expect, beforeAll, afterEach } from 'vitest';
import { createGitRunner } from '../src/git/repo-handle.js';
import { speculativeMerge } from '../src/merge/speculative-merge.js';
import type { UserRepo, ShadowRepo } from '../src/git/repo-handle.js';

let tempDirs: string[] = [];
const runner = createGitRunner();

beforeAll(() => {
  // Ensure the tests do not leak temp directories
  tempDirs = [];
});

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignored
    }
  }
  tempDirs = [];
});

function createTestRepo(): {
  user: UserRepo;
  shadow: ShadowRepo;
  git: (...args: string[]) => string;
} {
  const root = mkdtempSync(join(tmpdir(), 'speculative-merge-test-'));
  tempDirs.push(root);

  const git = (...args: string[]) => {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  };

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test User');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');

  const user: UserRepo = { kind: 'user', rootPath: root, gitDir: join(root, '.git') };
  const shadow: ShadowRepo = {
    kind: 'shadow',
    rootPath: root,
    gitDir: join(root, '.git'),
    originPath: root,
  };

  return { user, shadow, git };
}

test('speculativeMerge performs a clean merge and returns mergedTreeOid', async () => {
  const { shadow, git } = createTestRepo();

  writeFileSync(join(shadow.originPath, 'a.txt'), 'base\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');

  git('checkout', '-qb', 'b1');
  writeFileSync(join(shadow.originPath, 'a.txt'), 'base\nb1\n');
  git('commit', '-am', 'b1');
  const commitA = git('rev-parse', 'HEAD');

  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'b2');
  writeFileSync(join(shadow.originPath, 'b.txt'), 'b2\n');
  git('add', 'b.txt');
  git('commit', '-qm', 'b2');
  const commitB = git('rev-parse', 'HEAD');

  const result = await speculativeMerge({
    shadow,
    commitA,
    commitB,
    mergeBaseSha: baseCommit,
    runner,
  });

  expect(result.clean).toBe(true);
  expect(result.mergedTreeOid).toBeTruthy();
  expect(result.conflictedPaths).toEqual([]);
  expect(result.conflictedStages).toEqual([]);
  expect(result.durationMs).toBeGreaterThanOrEqual(0);

  // Verify the tree contains both files
  const lsTree = runner.run(shadow, ['ls-tree', result.mergedTreeOid!]);
  const treeOutput = (await lsTree).stdout;
  expect(treeOutput).toContain('a.txt');
  expect(treeOutput).toContain('b.txt');
});

test('speculativeMerge returns conflicted paths and stages on conflict', async () => {
  const { shadow, git } = createTestRepo();

  writeFileSync(join(shadow.originPath, 'a.txt'), 'base\n');
  git('add', 'a.txt');
  git('commit', '-qm', 'base');
  const baseCommit = git('rev-parse', 'HEAD');

  git('checkout', '-qb', 'b1');
  writeFileSync(join(shadow.originPath, 'a.txt'), 'b1\n');
  git('commit', '-am', 'b1');
  const commitA = git('rev-parse', 'HEAD');

  git('checkout', '-q', 'main');
  git('checkout', '-qb', 'b2');
  writeFileSync(join(shadow.originPath, 'a.txt'), 'b2\n');
  git('commit', '-am', 'b2');
  const commitB = git('rev-parse', 'HEAD');

  const result = await speculativeMerge({
    shadow,
    commitA,
    commitB,
    mergeBaseSha: baseCommit,
    runner,
  });

  expect(result.clean).toBe(false);
  expect(result.mergedTreeOid).toBeTruthy(); // Tree is still written
  expect(result.conflictedPaths).toEqual(['a.txt']);
  expect(result.conflictedStages).toHaveLength(3); // base, ours, theirs
  const stages = result.conflictedStages.map((s) => s.stage).sort();
  expect(stages).toEqual([1, 2, 3]);
  expect(result.conflictedStages[0]!.path).toBe('a.txt');
});

test.skipIf(process.platform === 'win32')(
  'speculativeMerge handles newlines in paths',
  async () => {
    const { shadow, git } = createTestRepo();

    const pathWithNewline = 'file\nname.txt';
    writeFileSync(join(shadow.originPath, pathWithNewline), 'base\n');
    git('add', pathWithNewline);
    git('commit', '-qm', 'base');
    const baseCommit = git('rev-parse', 'HEAD');

    git('checkout', '-qb', 'b1');
    writeFileSync(join(shadow.originPath, pathWithNewline), 'b1\n');
    git('commit', '-am', 'b1');
    const commitA = git('rev-parse', 'HEAD');

    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'b2');
    writeFileSync(join(shadow.originPath, pathWithNewline), 'b2\n');
    git('commit', '-am', 'b2');
    const commitB = git('rev-parse', 'HEAD');

    const result = await speculativeMerge({
      shadow,
      commitA,
      commitB,
      mergeBaseSha: baseCommit,
      runner,
    });

    expect(result.clean).toBe(false);
    expect(result.conflictedPaths).toEqual([pathWithNewline]);
  },
);
