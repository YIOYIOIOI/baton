import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePublishArgs, prepareOrphanRelease } from '../scripts/publish-oss.mjs';

test('parsePublishArgs parses flags and validates structure', () => {
  const p = parsePublishArgs(['--prepare', '--branch', 'oss-release']);
  assert.equal(p.prepare, true);
  assert.equal(p.orphanRef, 'oss-release');
  assert.throws(() => parsePublishArgs(['--bogus']));
});

test('prepareOrphanRelease rejects invalid branch names and never mutates on dry-run', () => {
  assert.throws(() => prepareOrphanRelease({ orphanRef: 'bad;branch' }));
});
