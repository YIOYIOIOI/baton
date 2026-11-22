import { createInterface } from 'node:readline';

const scenario = process.argv[2];
let promptId;
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const finishPrompt = () => send({ id: promptId, result: { stopReason: 'end_turn', usage: { outputTokens: 17 } } });

for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (scenario.startsWith('catalog')) {
    if (req.method === 'initialize') {
      send({ id: req.id, result: {} });
    } else if (req.method === 'session/list' && scenario === 'catalog-long') {
      process.stdout.write('界'.repeat(190));
    } else if (req.method === 'session/list') {
      send({ id: req.id, method: 'session/request_permission', params: {} });
    } else if (req.result?.outcome?.outcome === 'cancelled') {
      send({ id: req.id, result: { sessions: [{ sessionId: 'catalog-session' }] } });
    } else if (req.method === 'session/load') {
      send({ id: req.id, result: { configOptions: [{ id: 'model', currentValue: 'demo', options: [{ value: 'demo', name: '示例模型' }] }] } });
    }
    continue;
  }
  if (req.method === 'initialize' || req.method === 'session/load') {
    send({ id: req.id, result: req.method === 'initialize' ? {} : { sessionId: req.params.sessionId } });
  } else if (req.method === 'session/prompt') {
    promptId = req.id;
    if (scenario === 'permission') {
      send({ id: promptId, method: 'session/request_permission', params: { sessionId: req.params.sessionId } });
    } else if (scenario === 'output') {
      const update = Buffer.from(JSON.stringify({
        jsonrpc: '2.0', method: 'session/update',
        params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '跨块中文' } } },
      }) + '\n');
      for (let i = 0; i < 24; i++) {
        const cut = update.indexOf(Buffer.from('中')) + 1;
        process.stdout.write(update.subarray(0, cut));
        await new Promise((resolve) => setTimeout(resolve, 2));
        process.stdout.write(update.subarray(cut));
      }
      finishPrompt();
    } else if (scenario === 'long-frame') {
      process.stdout.write('界'.repeat(190));
    }
  } else if (req.id === promptId && req.result?.outcome?.outcome === 'cancelled') {
    send({ id: promptId, method: 'fixture/unsupported', params: {} });
  } else if (req.id === promptId && req.error?.code === -32601) {
    finishPrompt();
  }
}
