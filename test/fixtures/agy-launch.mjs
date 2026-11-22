import fs from 'node:fs';
import { createInterface } from 'node:readline';

fs.appendFileSync(process.env.BATON_FIXTURE_LOG, JSON.stringify({
  guard: process.env.NoDefaultCurrentDirectoryInExePath, path: process.env.PATH,
}) + '\n');
if (process.argv[2] === 'acp') {
  for await (const row of createInterface({ input: process.stdin })) {
    const request = JSON.parse(row);
    if (!request.method) continue;
    const result = request.method === 'session/list' ? { sessions: [{ sessionId: 'fixture' }] } :
      request.method === 'session/prompt' ? { stopReason: 'end_turn' } :
      { sessionId: request.params?.sessionId ?? 'fixture', configOptions: [{ id: 'model', currentValue: 'fixture', options: [{ value: 'fixture', name: 'Fixture' }] }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
  }
} else {
  process.stdin.resume();
  console.log(JSON.stringify({ event: 'result', status: 'ok' }));
}
