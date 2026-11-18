import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanPathName, scanText, verifyRepoClean } from '../scripts/verify-oss-clean.mjs';

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
});

test('verifyRepoClean succeeds on the current tracked workspace', () => {
  const res = verifyRepoClean();
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.ok(res.checkedFiles > 100);
});
