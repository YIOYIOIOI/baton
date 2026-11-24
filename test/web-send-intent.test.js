import test from 'node:test';
import assert from 'node:assert/strict';
import { sendIntent } from '../web/src/sendIntent.ts';
import { attachmentSuffix } from '../web/src/attach.ts';
import { canRetrySend } from '../app/src/api/sendWindow.ts';
import { RETRY_WINDOW_MS } from '../src/runtime/receipts.js';

test('retained client requests can retry only inside the server receipt window', () => {
  const start = 4321000;
  assert.equal(canRetrySend(start, start + RETRY_WINDOW_MS - 1), true);
  assert.equal(canRetrySend(start, start + RETRY_WINDOW_MS), false);
  assert.equal(canRetrySend(start, start - 1), false);
  assert.equal(canRetrySend(undefined, start), false);
});

test('retries reuse the exact payload, including fork, interrupt and attachment paths', () => {
  const message = 'fixture' + attachmentSuffix([{ relative: 'a.txt', bytes: 2 }]);
  for (const [fork, when] of [[false, 'auto'], [true, 'auto'], [false, 'interrupt']]) {
    const first = sendIntent(null, message, fork, when);
    assert.ok(canRetrySend(first.startedAt));
    assert.equal(sendIntent(first, message, fork, when).startedAt, first.startedAt);
    assert.equal(sendIntent(first, message, fork, when).id, first.id);
    assert.notEqual(sendIntent(first, 'fixture', fork, when).id, first.id);
    assert.notEqual(sendIntent(first, message, !fork, when).id, first.id);
    assert.notEqual(sendIntent(first, message, fork, when === 'auto' ? 'interrupt' : 'auto').id, first.id);
    assert.notEqual(sendIntent(null, message, fork, when).id, first.id);
  }
});
