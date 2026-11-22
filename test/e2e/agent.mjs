// Local stand-in for the vendor binary. Baton still uses its real CLI launcher,
// process pipes, transcript reader, HTTP routes, and persistent turn store.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.env.BATON_E2E_TRANSCRIPT) throw new Error('Missing isolated transcript.');
const id = process.argv[process.argv.indexOf('--resume') + 1];
let prompt = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) prompt += chunk;
const user = {
  type: 'user', uuid: crypto.randomUUID(), sessionId: id, cwd: process.cwd(),
  message: { role: 'user', content: prompt.trim() },
};
const reply = {
  type: 'assistant', uuid: crypto.randomUUID(), sessionId: id, timestamp: new Date().toISOString(),
  message: { role: 'assistant', content: [{ type: 'text', text: 'E2E runner received the message' }] },
};
fs.appendFileSync(process.env.BATON_E2E_TRANSCRIPT, JSON.stringify(user) + '\n');
const gate = path.join(process.cwd(), 'hold-prompt.txt');
if (fs.existsSync(gate) && fs.readFileSync(gate, 'utf8') === prompt.trim()) {
  const until = Date.now() + 25_000;
  while (fs.existsSync(gate) && Date.now() < until) await delay(50);
}
fs.appendFileSync(process.env.BATON_E2E_TRANSCRIPT, JSON.stringify(reply) + '\n');
console.log(JSON.stringify(reply));
console.log(JSON.stringify({ type: 'result', session_id: id, is_error: false, usage: { output_tokens: 7 } }));
