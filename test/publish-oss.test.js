import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parsePublishArgs, prepareOrphanRelease, updateReleaseRefs } from '../scripts/publish-oss.mjs';
import { verifyRepoClean } from '../scripts/verify-oss-clean.mjs';
import { tmpDir } from './helpers.js';

function fixtureRepo() {
  const cwd = tmpDir('baton-release-repo-');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(cwd, 'README.md'), 'public');
  git('add', 'README.md');
  git('commit', '-m', 'development');
  return { cwd, git };
}

test('parsePublishArgs parses flags and validates structure', () => {
  const p = parsePublishArgs(['--prepare', '--branch', 'oss-release']);
  assert.equal(p.prepare, true);
  assert.equal(p.orphanRef, 'oss-release');
  assert.throws(() => parsePublishArgs(['--bogus']));
});

test('prepareOrphanRelease rejects invalid branch names and never mutates on dry-run', () => {
  assert.throws(() => prepareOrphanRelease({ orphanRef: 'bad;branch' }));
  const { cwd, git } = fixtureRepo();
  const before = git('show-ref');
  assert.equal(prepareOrphanRelease({ cwd, dryRun: true }).commitSha, null);
  assert.equal(git('show-ref'), before);
});

test('the release CLI names the verified commit and rejects an invalid target before moving refs', () => {
  const { cwd, git } = fixtureRepo();
  const scripts = path.join(cwd, 'scripts');
  fs.mkdirSync(scripts);
  for (const script of ['publish-oss.mjs', 'verify-oss-clean.mjs']) {
    fs.copyFileSync(new URL(`../scripts/${script}`, import.meta.url), path.join(scripts, script));
  }
  git('add', 'scripts');
  git('commit', '-m', 'include release tools');
  const run = (target) => execFileSync(process.execPath,
    ['scripts/publish-oss.mjs', '--prepare', '--remote', 'fixture', '--target-branch', target],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const before = git('show-ref');
  assert.throws(() => run('invalid..branch'));
  assert.equal(git('show-ref'), before);
  const output = run('public');
  const verified = git('rev-parse', 'refs/baton/oss-release/oss-release');
  assert.ok(output.includes(`${verified}:refs/heads/public`));
});

test('release prep preserves developer refs and any checked-out managed release', () => {
  const { cwd, git } = fixtureRepo();
  const head = git('rev-parse', 'HEAD');
  git('branch', 'dev');
  for (const orphanRef of ['main', 'dev']) {
    assert.throws(() => prepareOrphanRelease({ cwd, orphanRef }), /unmanaged|checked-out/);
    assert.equal(git('rev-parse', orphanRef), head);
  }
  const first = prepareOrphanRelease({ cwd, message: 'public one' });
  assert.equal(git('rev-list', '--parents', first.commitSha), first.commitSha);
  const second = prepareOrphanRelease({ cwd, message: 'public two' });
  assert.equal(git('rev-parse', 'refs/heads/oss-release'), second.commitSha);
  assert.equal(git('rev-parse', 'refs/baton/oss-release/oss-release'), second.commitSha);
  assert.equal(git('rev-parse', 'HEAD'), head);
  const other = path.join(tmpDir('baton-release-worktree-'), 'checkout');
  git('worktree', 'add', other, 'oss-release');
  assert.throws(() => prepareOrphanRelease({ cwd }), /checked-out/);
  assert.equal(git('rev-parse', 'oss-release'), second.commitSha);
});

test('a competing writer cannot be overwritten and the release marker stays put', () => {
  const { cwd, git } = fixtureRepo();
  const { commitSha } = prepareOrphanRelease({ cwd });
  const branch = 'refs/heads/oss-release';
  const marker = 'refs/baton/oss-release/oss-release';
  const competitor = git('rev-parse', 'HEAD');
  git('update-ref', branch, competitor, commitSha);
  assert.throws(() => updateReleaseRefs(cwd, branch, marker, competitor, commitSha));
  assert.equal(git('rev-parse', branch), competitor);
  assert.equal(git('rev-parse', marker), commitSha);
  assert.throws(() => prepareOrphanRelease({ cwd }), /independently changed/);
});

test('the actual commit is scanned before moving refs, including in a shallow checkout', () => {
  const { cwd, git } = fixtureRepo();
  const good = prepareOrphanRelease({ cwd });
  const filename = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(filename, JSON.stringify({ sample: 'ghp' + '_' + 'x'.repeat(28) }));
  git('add', 'events.jsonl');
  git('commit', '-m', 'synthetic gate fixture');
  git('update-index', '--assume-unchanged', 'events.jsonl');
  fs.writeFileSync(filename, '{}');
  assert.throws(() => prepareOrphanRelease({ cwd }), /github-token/);
  assert.equal(git('rev-parse', 'oss-release'), good.commitSha);
  const shallow = path.join(tmpDir('baton-shallow-'), 'checkout');
  git('clone', '--no-local', '--depth=1', '.', shallow);
  assert.ok(verifyRepoClean({ cwd: shallow, ref: 'HEAD', orphan: true }).errors.some((e) => e.includes('zero-parent')));
});
