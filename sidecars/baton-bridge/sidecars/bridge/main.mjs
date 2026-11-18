import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const BATON_DIR = process.env.BATON_DIR || path.join(os.homedir(), '.baton');
const BRIDGES_DIR = path.join(BATON_DIR, 'antigravity-bridges');
const TOKEN_FILE = path.join(BATON_DIR, 'token');
const REG_FILE = path.join(BRIDGES_DIR, `${process.pid}.json`);
const MAX_JSON = 2 * 1024 * 1024;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readToken() {
  try {
    const t = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

function authorized(req) {
  const expected = readToken();
  if (!expected) return false;
  const auth = String(req.headers.authorization ?? '');
  if (!auth.startsWith('Bearer ')) return false;
  const provided = auth.slice(7).trim();
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function runAgentApi(args, { projectId } = {}) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(file, execArgs, { encoding: 'utf8', env, timeout: 25_000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || stdout || err.message || 'agentapi 调用失败').trim();
        return reject(new Error(msg));
      }
      const raw = (stdout || '').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
  });
}

function extractConversationId(result) {
  if (!result || typeof result !== 'object') return null;
  for (const key of ['conversationId', 'conversation_id', 'id']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
  }
  if (result.conversation && typeof result.conversation.id === 'string') return result.conversation.id;
  if (typeof result.raw === 'string') {
    const m = UUID_RE.exec(result.raw);
    if (m) return m[0];
  }
  return null;
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_JSON) throw new Error('请求体过大');
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function removeReg() {
  try {
    fs.unlinkSync(REG_FILE);
  } catch {
    // 已移除
  }
}

async function main() {
  // 仅当宿主注入了 UI sidecar 端口时才启动 sidecar_sdk 的 Web UI 服务器
  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT && process.env.ANTIGRAVITY_LS_ADDRESS && process.env.ANTIGRAVITY_CSRF_TOKEN) {
    try {
      const { SidecarApp } = await import('sidecar_sdk');
      await new SidecarApp().run();
    } catch (err) {
      console.error('[baton-bridge] SidecarApp warning:', err?.message ?? err);
    }
  }

  const server = http.createServer(async (req, res) => {
    if (!authorized(req)) {
      send(res, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        send(res, 200, {
          ok: true,
          pid: process.pid,
          projectId: process.env.ANTIGRAVITY_PROJECT_ID ?? null,
          hasAgentApi: Boolean(process.env.ANTIGRAVITY_AGENTAPI_EXE),
        });
        return;
      }

      if (req.method !== 'POST') {
        send(res, 405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      const body = await readJson(req);
      const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;

      if (url.pathname === '/send-message') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        const message = typeof body.message === 'string' ? body.message : '';
        if (!conversationId || !message.trim()) {
          send(res, 400, { ok: false, error: 'missing_conversation_or_message' });
          return;
        }
        if (!SAFE_ID_RE.test(conversationId)) {
          send(res, 400, { ok: false, error: 'invalid_conversation_id' });
          return;
        }
        const args = ['send-message'];
        if (typeof body.title === 'string' && body.title.trim()) args.push(`--title=${body.title.trim()}`);
        args.push(conversationId, message);
        const result = await runAgentApi(args, { projectId });
        send(res, 200, { ok: true, result });
        return;
      }

      if (url.pathname === '/new-conversation') {
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message.trim()) {
          send(res, 400, { ok: false, error: 'missing_message' });
          return;
        }
        const args = ['new-conversation'];
        if (typeof body.model === 'string' && body.model.trim()) args.push(`--model=${body.model.trim()}`);
        if (typeof body.title === 'string' && body.title.trim()) args.push(`--title=${body.title.trim()}`);
        args.push(message);
        const result = await runAgentApi(args, { projectId });
        const conversationId = extractConversationId(result);
        send(res, 200, { ok: true, conversationId, result });
        return;
      }

      if (url.pathname === '/metadata') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!conversationId) {
          send(res, 400, { ok: false, error: 'missing_conversation_id' });
          return;
        }
        if (!SAFE_ID_RE.test(conversationId)) {
          send(res, 400, { ok: false, error: 'invalid_conversation_id' });
          return;
        }
        const result = await runAgentApi(['get-conversation-metadata', conversationId], { projectId });
        send(res, 200, { ok: true, result });
        return;
      }

      send(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      send(res, 500, { ok: false, error: err?.message ?? 'internal_error' });
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  fs.mkdirSync(BRIDGES_DIR, { recursive: true });
  const tmp = `${REG_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({
    pid: process.pid,
    port,
    host: '127.0.0.1',
    projectId: process.env.ANTIGRAVITY_PROJECT_ID ?? null,
    startedAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, REG_FILE);

  process.on('exit', removeReg);
  process.on('SIGINT', () => { removeReg(); process.exit(0); });
  process.on('SIGTERM', () => { removeReg(); process.exit(0); });
}

main().catch((err) => {
  console.error('[baton-bridge] fatal:', err);
  removeReg();
  process.exit(1);
});
