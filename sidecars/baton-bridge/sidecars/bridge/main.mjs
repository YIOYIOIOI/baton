import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readRegistration, registryDirectory } from './registry.mjs';
import {
  healthProof, isNonce, LOOPBACK, MAX_BODY, newNonce, PROTOCOL, responseProof, verifyRequest,
} from './protocol.mjs';

const BATON_DIR = process.env.BATON_DIR || path.join(os.homedir(), '.baton');
const BRIDGES_DIR = path.join(BATON_DIR, 'antigravity-bridges');
const REG_FILE = path.join(BRIDGES_DIR, `${process.pid}.json`);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const instance = {
  protocol: PROTOCOL, host: LOOPBACK, pid: process.pid, port: 0, projectId: process.env.ANTIGRAVITY_PROJECT_ID ?? null,
  instanceId: crypto.randomUUID(), secret: newNonce(), startedAt: new Date().toISOString(),
};
const usedNonces = new Map();

function runAgentApi(args, projectId, onSpawn) {
  const env = { ...process.env };
  if (projectId) env.ANTIGRAVITY_PROJECT_ID = projectId;
  const exe = process.env.ANTIGRAVITY_AGENTAPI_EXE;
  const file = exe || 'agentapi';
  const execArgs = exe ? ['agentapi', ...args] : args;
  return new Promise((resolve, reject) => {
    const child = execFile(file, execArgs, { encoding: 'utf8', env, timeout: 25_000, windowsHide: true }, (err, stdout, stderr) => {
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
    child.once('spawn', onSpawn);
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

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY) throw new Error('请求体过大');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function removeReg() {
  try {
    registryDirectory(BATON_DIR);
    if (readRegistration(REG_FILE)?.instanceId === instance.instanceId) fs.unlinkSync(REG_FILE);
  } catch {
    // 已移除
  }
}

async function main() {
  registryDirectory(BATON_DIR, { publish: true });
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
    let verifiedNonce = null;
    let agentApiStarted = false;
    const invoke = (args, projectId) => runAgentApi(args, projectId, () => { agentApiStarted = true; });
    const send = (status, body) => {
      const raw = JSON.stringify(verifiedNonce && !body.ok
        ? { ...body, delivery: agentApiStarted ? 'unknown' : 'not_dispatched' }
        : body);
      const headers = { 'Content-Type': 'application/json; charset=utf-8' };
      if (verifiedNonce) headers['x-baton-proof'] = responseProof(instance, verifiedNonce, status, raw);
      res.writeHead(status, headers).end(raw);
    };
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        const challenge = url.searchParams.get('challenge');
        if (!isNonce(challenge)) return send(400, { ok: false, error: 'invalid_challenge' });
        send(200, {
          ok: true, protocol: PROTOCOL, pid: instance.pid, projectId: instance.projectId,
          instanceId: instance.instanceId, proof: healthProof(instance, challenge),
        });
        return;
      }

      if (req.method !== 'POST') {
        send(405, { ok: false, error: 'method_not_allowed' });
        return;
      }

      if (!isNonce(req.headers['x-baton-proof'])) return send(401, { ok: false, error: 'unauthorized' });
      const raw = await readBody(req);
      if (!verifyRequest(instance, req.url, raw, req.headers, usedNonces)) {
        return send(401, { ok: false, error: 'unauthorized' });
      }
      verifiedNonce = req.headers['x-baton-nonce'];
      let body;
      try {
        body = JSON.parse(raw.toString('utf8') || '{}');
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
      } catch {
        return send(400, { ok: false, error: 'invalid_json' });
      }
      const projectId = typeof body.projectId === 'string' && body.projectId.trim() ? body.projectId.trim() : undefined;

      if (url.pathname === '/send-message') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        const message = typeof body.message === 'string' ? body.message : '';
        if (!conversationId || !message.trim()) {
          send(400, { ok: false, error: 'missing_conversation_or_message' });
          return;
        }
        if (!SAFE_ID_RE.test(conversationId)) {
          send(400, { ok: false, error: 'invalid_conversation_id' });
          return;
        }
        const args = ['send-message'];
        if (typeof body.title === 'string' && body.title.trim()) args.push(`--title=${body.title.trim()}`);
        args.push(conversationId, message);
        const result = await invoke(args, projectId);
        send(200, { ok: true, result });
        return;
      }

      if (url.pathname === '/new-conversation') {
        const message = typeof body.message === 'string' ? body.message : '';
        if (!message.trim()) {
          send(400, { ok: false, error: 'missing_message' });
          return;
        }
        const args = ['new-conversation'];
        if (typeof body.model === 'string' && body.model.trim()) args.push(`--model=${body.model.trim()}`);
        if (typeof body.title === 'string' && body.title.trim()) args.push(`--title=${body.title.trim()}`);
        args.push(message);
        const result = await invoke(args, projectId);
        const conversationId = extractConversationId(result);
        send(200, { ok: true, conversationId, result });
        return;
      }

      if (url.pathname === '/metadata') {
        const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
        if (!conversationId) {
          send(400, { ok: false, error: 'missing_conversation_id' });
          return;
        }
        if (!SAFE_ID_RE.test(conversationId)) {
          send(400, { ok: false, error: 'invalid_conversation_id' });
          return;
        }
        const result = await invoke(['get-conversation-metadata', conversationId], projectId);
        send(200, { ok: true, result });
        return;
      }

      send(404, { ok: false, error: 'not_found' });
    } catch (err) {
      send(500, { ok: false, error: err?.message ?? 'internal_error' });
    }
  });

  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
  const addr = server.address();
  instance.port = addr.port;

  const tmp = REG_FILE + '.' + instance.instanceId + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(instance) + '\n', { mode: 0o600, flag: 'wx' });
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
