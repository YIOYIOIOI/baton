import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scanPathName, scanText, verifyRepoClean } from '../scripts/verify-oss-clean.mjs';
import { tmpDir } from './helpers.js';

test('scanPathName rejects sensitive runtime/credential filenames', () => {
  assert.ok(scanPathName('token').length > 0);
  assert.ok(scanPathName('.env.local').length > 0);
  assert.ok(scanPathName('docs/ops/notes.local.md').length > 0);
  assert.ok(scanPathName('secrets/cert.pem').length > 0);
  assert.equal(scanPathName('README.md').length, 0);
});

test('scanText detects synthetic secrets and real user paths while allowing documented examples', () => {
  const badKey = `${'ghp'}_${'a'.repeat(32)}`;
  assert.ok(scanText('src/demo.js', `const tok = "${badKey}";`).length > 0);

  const badKeyAnt = `${'sk-ant'}-${'xyz1234567890abcdef'}`;
  assert.ok(scanText('src/demo.js', badKeyAnt).length > 0);

  const fakeName = 'john' + 'doe';
  assert.ok(scanText('docs/a.md', `See C:\\Users\\${fakeName}\\.baton for details`).length > 0);
  assert.ok(scanText('docs/a.md', `/Users/${fakeName}/project`).length > 0);

  assert.equal(scanText('test/demo.js', 'C:\\Users\\alice\\.baton\\token').length, 0);
  assert.equal(scanText('test/demo.js', '/home/runner/work/baton').length, 0);
  assert.equal(scanText('README.md', '/home/<username>/projects').length, 0);

  const virtual = '/home/' + 'web_user';
  assert.deepEqual(scanText('index.js', `const env = { HOME: "${virtual}" };`), []);
  assert.equal(scanText('index.js', `const env = { HOME:"${virtual}/private" };`).length, 1);
  assert.equal(scanText('index.js', `const env = { HOME:"${virtual}", another:"${virtual}" };`).length, 1);
});

test('verifyRepoClean scans tracked JSONL fixtures in a clean repository', () => {
  const cwd = tmpDir('baton-tracked-gate-');
  execFileSync('git', ['init', '-q'], { cwd });
  const fixture = path.join(cwd, 'events.jsonl');
  fs.writeFileSync(fixture, JSON.stringify({ note: 'public fixture' }));
  execFileSync('git', ['add', 'events.jsonl'], { cwd });
  const res = verifyRepoClean({ cwd });
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.equal(res.checkedFiles, 1);
  fs.writeFileSync(fixture, JSON.stringify({ sample: 'ghp' + '_' + 'a'.repeat(32) }));
  assert.ok(verifyRepoClean({ cwd }).errors.some((e) => e.includes('github-token')));
});

test('the post-pack gate scans generated files in the actual archive without Git metadata', () => {
  const fixture = tmpDir('baton-package-gate-');
  const directory = path.join(fixture, 'package/web/dist');
  const unpacked = path.join(fixture, 'unpacked');
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(unpacked);
  const synthetic = 'ghp' + '_' + 'fixture'.repeat(5);
  const archive = path.join(fixture, 'release.tgz');
  const verifier = path.resolve('scripts/verify-oss-clean.mjs');
  for (const [content, expected] of [[synthetic, 1], ['public', 0]]) {
    fs.writeFileSync(path.join(directory, 'events.jsonl'), JSON.stringify({ content }));
    fs.writeFileSync(path.join(directory, 'output.map'), JSON.stringify({ content }));
    fs.writeFileSync(path.join(directory, 'asset.bin'), Buffer.from(`\0\xff\0${content}`, 'latin1'));
    execFileSync('tar', ['-czf', archive, '-C', fixture, 'package']);
    execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
    const r = spawnSync(process.execPath, [verifier, '--release-dir', path.join(unpacked, 'package')], { cwd: fixture, encoding: 'utf8' });
    assert.equal(r.status, expected, r.stderr);
    if (expected) {
      assert.match(r.stderr, /events\.jsonl: matched forbidden secret rule/);
      assert.match(r.stderr, /output\.map: matched forbidden secret rule/);
      assert.match(r.stderr, /asset\.bin: matched forbidden secret rule/);
      assert.ok(!r.stderr.includes(synthetic));
    }
  }
});
