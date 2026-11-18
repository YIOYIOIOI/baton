/**
 * `mcp__baton__ask` 的 MCP stdio 服务器。
 *
 * **由 claude 拉起，不是由守护进程拉起。** 进程树是：
 *
 *   Baton 守护进程 ──spawn──> claude -p --mcp-config … ──spawn──> 这个文件
 *
 * 所以它拿不到守护进程的任何内存状态，只能回连。回连地址与这一轮的一次性
 * 令牌由环境变量传进来（守护进程 spawn claude 时塞的，一路继承下来）。
 *
 * 协议是 JSON-RPC 2.0 按行分隔。实测 claude 2.1.281 依次发：
 *
 *   {"method":"initialize","params":{"protocolVersion":"2025-11-25",…},"id":0}
 *   {"jsonrpc":"2.0","method":"notifications/initialized"}
 *   {"method":"tools/list","jsonrpc":"2.0","id":1}
 *   {"method":"tools/call","params":{"name":"ask","arguments":{…}},"id":2}
 *
 * **stdout 只能出 JSON-RPC。** 任何 console.log 都会被当成帧，连接当场作废——
 * 所以这里一行日志都不打，出错也只经 stderr。
 */
import readline from 'node:readline';
import { ASK_HEADER, ASK_TOOL_SHORT } from './protocol.js';

const URL_BASE = process.env.BATON_ASK_URL ?? '';
const TOKEN = process.env.BATON_ASK_TOKEN ?? '';

/**
 * 工具描述就是给模型看的说明书，措辞直接决定它在什么时候调。
 *
 * 两条都必须写明：**会阻塞**（否则模型会以为可以先问后答、接着往下跑），
 * 以及**什么时候不要用**（否则每一句话都要问一遍，手机上比打字还烦）。
 */
const TOOL = {
  name: ASK_TOOL_SHORT,
  description: [
    '把一道选择题推到用户的手机/网页上，等他点选，然后把答案返回给你。',
    '',
    '什么时候用：你必须在几条互斥的路线之间做决定，而选错的代价大于问一句的成本——',
    '比如「先改 A 还是先改 B」「这个文件是删还是留」「用方案一还是方案二」。',
    '',
    '什么时候不要用：答案你自己查得到、选项之间差别不大、或者你只是想确认一下。',
    '那些情况直接做，做完在回复里说明你怎么选的。',
    '',
    '注意：这个调用会**一直阻塞到用户回答**（最长 4 分钟）。一轮里最多问一次，',
    '把所有要问的并成一道题。用户可能不选给定项而是自己写一段，照他写的做。',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: '问题本身，一句话。' },
      header: { type: 'string', description: '可选。四个字以内的抬头，手机上做卡片标题。' },
      options: {
        type: 'array',
        minItems: 2,
        maxItems: 8,
        description: '互斥的选项，至少 2 个。推荐项放第一个。',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: '按钮上的字，越短越好。' },
            description: { type: 'string', description: '可选。选它意味着什么、代价是什么。' },
          },
          required: ['label'],
        },
      },
      multiSelect: { type: 'boolean', description: '可否多选。默认否。' },
    },
    required: ['question', 'options'],
  },
};

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const ok = (id, result) => send({ jsonrpc: '2.0', id, result });
const textResult = (id, text, isError = false) => ok(id, {
  content: [{ type: 'text', text }],
  isError,
});

async function callAsk(args) {
  if (!URL_BASE || !TOKEN) {
    return { text: 'Baton 没有为这一轮开启提问通道，这个工具现在不可用。把问题写进回复正文里。', isError: true };
  }
  let res;
  try {
    res = await fetch(`${URL_BASE}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [ASK_HEADER]: TOKEN },
      body: JSON.stringify(args ?? {}),
    });
  } catch (e) {
    // 守护进程没了 / 端口变了。让 agent 知道是通道的问题，不是用户拒绝回答。
    return { text: `提问通道连不上（${e.message}）。把问题写进回复正文里，不要再调这个工具。`, isError: true };
  }
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    return { text: body?.error?.message ?? `提问失败（HTTP ${res.status}）。`, isError: true };
  }
  return { text: String(body?.answer ?? ''), isError: false };
}

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 认不出的帧直接跳过，绝不因此中断连接
  }
  const { id, method } = msg;

  if (method === 'initialize') {
    // 回声对方的协议版本：我们没有任何版本相关的行为，跟着走最不容易谈崩
    ok(id, {
      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'baton', version: '1' },
    });
    return;
  }
  if (method === 'tools/list') {
    ok(id, { tools: [TOOL] });
    return;
  }
  if (method === 'tools/call') {
    if (msg.params?.name !== ASK_TOOL_SHORT) {
      textResult(id, `没有这个工具：${msg.params?.name}`, true);
      return;
    }
    const r = await callAsk(msg.params?.arguments);
    textResult(id, r.text, r.isError);
    return;
  }
  if (method === 'ping') {
    ok(id, {});
    return;
  }
  // 通知没有 id，不该回；其余带 id 的方法回个空结果，别让对方等着
  if (id !== undefined && id !== null) ok(id, {});
});

// stdin 关了就是 claude 那一轮结束了，跟着退出，别留孤儿进程
rl.on('close', () => process.exit(0));
