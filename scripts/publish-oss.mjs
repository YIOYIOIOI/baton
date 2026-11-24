#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyRepoClean } from './verify-oss-clean.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function git(args, cwd = REPO_ROOT, input = undefined) {
  return execFileSync('git', args, { cwd, input, stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
}

export function parsePublishArgs(argv) {
  let prepare = false;
  let dryRun = false;
  let push = false;
  let remote = null;
  let targetBranch = 'main';
  let orphanRef = 'oss-release';
  let message = 'feat: initial open-source release of Baton v0.2.0';

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--prepare') prepare = true;
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--push') push = true;
    else if (a === '--remote' && argv[i + 1]) remote = argv[++i];
    else if (a === '--target-branch' && argv[i + 1]) targetBranch = argv[++i];
    else if (a === '--branch' && argv[i + 1]) orphanRef = argv[++i];
    else if (a === '--message' && argv[i + 1]) message = argv[++i];
    else if (a === '--help' || a === '-h') return { help: true };
    else throw new Error(`Unknown option: ${a}`);
  }
  return { help: false, prepare, dryRun, push, remote, targetBranch, orphanRef, message };
}

export function updateReleaseRefs(cwd, branchRef, managedRef, commitSha, expected) {
  git(['update-ref', '--no-deref', '--stdin'], cwd,
    `update ${branchRef} ${commitSha} ${expected}\nupdate ${managedRef} ${commitSha} ${expected}\n`);
}

export function prepareOrphanRelease({
  cwd = REPO_ROOT,
  orphanRef = 'oss-release',
  message = 'feat: initial open-source release of Baton v0.2.0',
  dryRun = false,
} = {}) {
  if (!/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(orphanRef)) {
    throw new Error(`Invalid orphan branch name: ${orphanRef}`);
  }
  const branchRef = `refs/heads/${orphanRef}`;
  const managedRef = `refs/baton/oss-release/${orphanRef}`;
  git(['check-ref-format', '--branch', orphanRef], cwd);
  const refs = new Map(git(['for-each-ref', '--format=%(refname) %(objectname) %(symref)', branchRef, managedRef], cwd)
    .split('\n').filter(Boolean).map((line) => {
      const [name, sha, symbolic] = line.split(' ');
      if (symbolic) throw new Error(`Refusing to replace symbolic ref ${name}`);
      return [name, sha];
    }));
  const previous = refs.get(branchRef);
  if (previous !== refs.get(managedRef)) {
    throw new Error(`Refusing to replace unmanaged or independently changed branch ${orphanRef}`);
  }
  function assertNotCheckedOut() {
    if (git(['worktree', 'list', '--porcelain', '-z'], cwd).split('\0').includes(`branch ${branchRef}`)) {
      throw new Error(`Refusing to replace checked-out branch ${orphanRef}`);
    }
  }
  assertNotCheckedOut();
  const status = git(['status', '--porcelain'], cwd);
  if (status) {
    throw new Error(`Working tree is not clean. Commit or clean changes first:\n${status}`);
  }
  const treeSha = git(['rev-parse', 'HEAD^{tree}'], cwd);
  const currentBranch = git(['branch', '--show-current'], cwd);
  const commitSha = dryRun ? null : git(['commit-tree', treeSha, '-m', message], cwd);
  const clean = verifyRepoClean({ cwd, ref: commitSha ?? treeSha, orphan: !dryRun });
  if (!clean.ok) {
    throw new Error(`OSS sanitization gate failed:\n${clean.errors.join('\n')}`);
  }
  if (dryRun) {
    return { dryRun: true, currentBranch, orphanRef, treeSha, commitSha: null, checkedFiles: clean.checkedFiles };
  }

  assertNotCheckedOut();
  // The marker records the last value we published. Both refs advance or neither does.
  const expected = previous ?? '0'.repeat(treeSha.length);
  updateReleaseRefs(cwd, branchRef, managedRef, commitSha, expected);

  return {
    dryRun: false,
    currentBranch,
    orphanRef,
    treeSha,
    commitSha,
    checkedFiles: clean.checkedFiles,
  };
}

function main() {
  const opts = parsePublishArgs(process.argv.slice(2));
  if (opts.help) {
    console.log([
      'Usage: node scripts/publish-oss.mjs [--prepare] [--dry-run] [--remote <url> --push]',
      '',
      '  --prepare              Build zero-parent oss-release branch without switching HEAD',
      '  --dry-run              Verify cleanliness and inspect tree SHA without updating refs',
      '  --remote <url>         Remote URL or name to push oss-release:main to',
      '  --push                 Execute git push after verification (requires --remote)',
    ].join('\n'));
    return;
  }

  if (opts.push && !opts.remote) {
    throw new Error('--push requires --remote <url-or-remote-name>.');
  }
  if (opts.remote) git(['check-ref-format', `refs/heads/${opts.targetBranch}`]);

  const res = prepareOrphanRelease({
    orphanRef: opts.orphanRef,
    message: opts.message,
    dryRun: opts.dryRun || (!opts.prepare && !opts.push),
  });

  if (res.dryRun) {
    console.log(`[dry-run] branch=${res.orphanRef}, current=${res.currentBranch}, tree=${res.treeSha}, files=${res.checkedFiles}`);
    return;
  }

  console.log(`Prepared orphan branch '${res.orphanRef}' (${res.commitSha}) from tree ${res.treeSha} (${res.checkedFiles} clean files).`);
  console.log(`Current workspace branch remains '${res.currentBranch}'.`);

  if (opts.push) {
    git(['push', '--', opts.remote, `${res.commitSha}:refs/heads/${opts.targetBranch}`]);
    console.log(`Pushed ${res.orphanRef} -> ${opts.remote} (${opts.targetBranch}).`);
  } else if (opts.remote) {
    console.log(`Prepared push to ${opts.remote}: ${res.commitSha}:refs/heads/${opts.targetBranch} (pass --push to execute).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
