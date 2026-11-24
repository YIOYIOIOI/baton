import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAuth, isLocalRequest } from '../src/http/auth.js';
import { createServer } from '../src/http/server.js';
import { createRepo } from '../src/repo.js';
import { OWNER } from '../src/principals.js';
import {
  TerminalLaunchError,
  buildInteractiveAgentCommand,
  buildTerminalLaunchSpec,
  cleanTerminalEnv,
  detectAntigravityProduct,
  findLinuxTerminal,
  findPosixBinary,
  findWindowsPowerShell,
  hasControlChars,
  isAbsoluteSessionCwd,
  launchLocalTerminal,
  posixQuote,
  resolveSessionCwd,
  sanitizeTerminalTitle,
  supportsLocalTerminal,
  win32QuoteArg,
} from '../src/agent/terminal.js';
import { tmpDir, writeJsonl } from './helpers.js';

const TOKEN = 'd'.repeat(64);
const CLAUDE_ID = 'aaaaaaaa-0000-0000-0000-000000000011';
const CODEX_ID = 'bbbbbbbb-0000-0000-0000-000000000022';
const AG_CLI_ID = 'cccccccc-0000-0000-0000-000000000033';
const AG_DESKTOP_ID = 'dddddddd-0000-0000-0000-000000000044';

function fakeReq({ remote = '127.0.0.1', headers = {} } = {}) {
  return { socket: { remoteAddress: remote }, headers };
}

function createSummaryDb(dbFile, rows) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const db = new DatabaseSync(dbFile);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT,
        workspace_uris TEXT,
        project_id TEXT,
        status TEXT,
        not_fully_idle INTEGER,
        nesting_depth INTEGER,
        killed INTEGER,
        parent_conversation_id TEXT,
        last_modified_time TEXT
      );
    `);
    const stmt = db.prepare(`
      INSERT INTO conversation_summaries (
        conversation_id, title, workspace_uris, project_id, status,
        not_fully_idle, nesting_depth, killed, parent_conversation_id, last_modified_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const r of rows) {
      stmt.run(
        r.id, r.title ?? 'Session', JSON.stringify(r.uris ?? []), r.projectId ?? null,
        r.status ?? 'CASCADE_RUN_STATUS_IDLE', 0, r.nestingDepth ?? 0, r.killed ?? 0,
        r.parentId ?? null, '2026-11-20T00:00:00Z',
      );
    }
  } finally {
    db.close();
  }
}

test('isLocalRequest 仅放行本机回环直连，拒绝代理、隧道与非回环来源', () => {
  assert.equal(isLocalRequest(fakeReq({ remote: '127.0.0.1', headers: { host: '127.0.0.1:3002' } })), true);
  assert.equal(isLocalRequest(fakeReq({ remote: '::1', headers: { host: 'localhost:3002' } })), true);
  assert.equal(isLocalRequest(fakeReq({ remote: '::ffff:127.0.0.1', headers: { host: '[::1]:3002' } })), true);
  assert.equal(isLocalRequest(fakeReq({
    remote: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', origin: 'http://localhost:5173', referer: 'http://127.0.0.1:3002/session/x' },
  })), true);

  // 非回环对端 IP（局域网 / Tailscale）
  assert.equal(isLocalRequest(fakeReq({ remote: '192.168.1.25', headers: { host: '127.0.0.1:3002' } })), false);
  assert.equal(isLocalRequest(fakeReq({ remote: '100.80.1.2', headers: { host: 'localhost:3002' } })), false);

  // 经由 Cloudflare Tunnel 或反向代理转发到 127.0.0.1（包含 x-forwarded-* / cf-* 前缀匹配）
  for (const header of [
    'forwarded', 'via', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-port',
    'x-forwarded-proto', 'x-forwarded-server', 'x-forwarded-prefix', 'x-real-ip',
    'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'cf-worker',
    'cdn-loop', 'true-client-ip',
  ]) {
    assert.equal(
      isLocalRequest(fakeReq({ remote: '127.0.0.1', headers: { host: '127.0.0.1:3002', [header]: '203.0.113.10' } })),
      false,
      `携带 ${header} 时必须判定为非本地直连`,
    );
  }

  // 非回环 Host / Origin / Referer 或非 http(s) 协议
  assert.equal(isLocalRequest(fakeReq({ remote: '127.0.0.1', headers: { host: 'baton.example.com' } })), false);
  assert.equal(isLocalRequest(fakeReq({ remote: '127.0.0.1', headers: { host: 'localhost.evil.com:3002' } })), false);
  assert.equal(isLocalRequest(fakeReq({ remote: '127.0.0.1', headers: {} })), false);
  assert.equal(isLocalRequest(fakeReq({
    remote: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', origin: 'https://baton.example.com' },
  })), false);
  assert.equal(isLocalRequest(fakeReq({
    remote: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', origin: 'null' },
  })), false);
  assert.equal(isLocalRequest(fakeReq({
    remote: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', origin: 'file://localhost/tmp/x.html' },
  })), false);
  assert.equal(isLocalRequest(fakeReq({
    remote: '127.0.0.1',
    headers: { host: '127.0.0.1:3002', referer: 'https://evil.example/page' },
  })), false);
});

test('detectAntigravityProduct、supportsLocalTerminal 与 buildInteractiveAgentCommand 准确区分产品并防误判', () => {
  const claude = { agent: 'claude', providerId: CLAUDE_ID, cwd: '/repo' };
  const codex = { agent: 'codex', providerId: CODEX_ID, cwd: '/repo' };
  const agCli = { agent: 'antigravity', providerId: AG_CLI_ID, cwd: '/repo', relPath: `antigravity-cli/brain/${AG_CLI_ID}/.system_generated/logs/transcript.jsonl` };
  const agDesk = { agent: 'antigravity', providerId: AG_DESKTOP_ID, cwd: '/repo', relPath: `antigravity/brain/${AG_DESKTOP_ID}/.system_generated/logs/transcript.jsonl` };
  const agIde = { agent: 'antigravity', providerId: AG_DESKTOP_ID, cwd: '/repo', relPath: `antigravity-ide/brain/${AG_DESKTOP_ID}/.system_generated/logs/transcript.jsonl` };

  // 祖先目录名碰巧叫 antigravity-cli 时，不得把桌面会话误判成 antigravity-cli
  assert.equal(
    detectAntigravityProduct({ file: `/tmp/antigravity-cli/.gemini/antigravity/brain/${AG_DESKTOP_ID}/.system_generated/logs/transcript.jsonl` }),
    'antigravity',
  );
  // Windows 路径下即使混用斜杠也能正确锚定 <product>/brain/
  assert.equal(
    detectAntigravityProduct({ file: `C:\\Users\\demo\\.gemini\\antigravity-cli\\brain\\${AG_CLI_ID}\\.system_generated\\logs\\transcript.jsonl` }),
    'antigravity-cli',
  );

  assert.equal(supportsLocalTerminal(claude, 'linux'), true);
  assert.equal(supportsLocalTerminal(codex, 'linux'), true);
  assert.equal(supportsLocalTerminal(agCli, 'linux'), true);
  assert.equal(supportsLocalTerminal(agDesk, 'linux'), false);
  assert.equal(supportsLocalTerminal(agIde, 'linux'), false);
  assert.equal(supportsLocalTerminal({ ...claude, cwd: null }, 'linux'), false);
  assert.equal(supportsLocalTerminal({ ...claude, cwd: '.' }, 'linux'), false);
  assert.equal(supportsLocalTerminal({ ...claude, cwd: 'subdir' }, 'linux'), false);
  assert.equal(supportsLocalTerminal({ ...claude, cwd: '/repo/\x03evil' }, 'linux'), false);
  assert.equal(supportsLocalTerminal({ ...claude, providerId: 'not-a-uuid' }, 'linux'), false);

  // Windows 下必须拒绝相对路径、无盘符根相对路径（\foo / /foo）与盘符相对路径（C:foo）
  assert.equal(supportsLocalTerminal({ ...claude, cwd: 'C:\\repo' }, 'win32'), true);
  assert.equal(supportsLocalTerminal({ ...claude, cwd: '\\\\server\\share\\repo' }, 'win32'), true);
  for (const badCwd of ['.', 'subdir', '\\foo', '/foo', 'C:foo']) {
    assert.equal(isAbsoluteSessionCwd(badCwd, 'win32'), false, `win32 必须拒绝 ${badCwd}`);
    assert.equal(supportsLocalTerminal({ ...claude, cwd: badCwd }, 'win32'), false, `win32 supportsLocalTerminal 必须拒绝 ${badCwd}`);
  }

  assert.deepEqual(buildInteractiveAgentCommand(claude), { cli: 'claude', args: ['--resume', CLAUDE_ID], sessionId: CLAUDE_ID, model: null, effort: null });
  assert.deepEqual(buildInteractiveAgentCommand(codex), { cli: 'codex', args: ['resume', CODEX_ID], sessionId: CODEX_ID, model: null, effort: null });
  assert.deepEqual(buildInteractiveAgentCommand(agCli), { cli: 'agy', args: ['--conversation', AG_CLI_ID], sessionId: AG_CLI_ID, model: null, effort: null });

  // 透传 Baton 的权限档位、模型与思考强度（Codex 选项位于 <SESSION_ID> 之前）
  assert.deepEqual(
    buildInteractiveAgentCommand(claude, { permissionMode: 'bypass', model: 'claude-opus-4-6', effort: 'max' }),
    {
      cli: 'claude',
      args: ['--resume', CLAUDE_ID, '--model', 'claude-opus-4-6', '--dangerously-skip-permissions', '--effort', 'max'],
      sessionId: CLAUDE_ID,
      model: 'claude-opus-4-6',
      effort: 'max',
    },
  );
  assert.deepEqual(
    buildInteractiveAgentCommand(claude, { permissionMode: 'edits', effort: 'ultra' }),
    {
      cli: 'claude',
      args: ['--resume', CLAUDE_ID, '--permission-mode', 'acceptEdits'],
      sessionId: CLAUDE_ID,
      model: null,
      effort: null,
    },
  );
  assert.deepEqual(
    buildInteractiveAgentCommand(codex, { permissionMode: 'bypass', model: 'gpt-5.4', effort: 'ultra' }),
    {
      cli: 'codex',
      args: ['resume', '--model', 'gpt-5.4', '--dangerously-bypass-approvals-and-sandbox', '-c', 'model_reasoning_effort=ultra', CODEX_ID],
      sessionId: CODEX_ID,
      model: 'gpt-5.4',
      effort: 'ultra',
    },
  );
  assert.deepEqual(
    buildInteractiveAgentCommand(codex, { permissionMode: 'read' }),
    {
      cli: 'codex',
      args: ['resume', '--sandbox', 'read-only', CODEX_ID],
      sessionId: CODEX_ID,
      model: null,
      effort: null,
    },
  );
  assert.deepEqual(
    buildInteractiveAgentCommand(agCli, { permissionMode: 'bypass', model: 'gemini-2.5-pro', effort: 'high' }),
    {
      cli: 'agy',
      args: ['--conversation', AG_CLI_ID, '--model', 'gemini-2.5-pro', '--dangerously-skip-permissions', '--effort', 'high'],
      sessionId: AG_CLI_ID,
      model: 'gemini-2.5-pro',
      effort: 'high',
    },
  );
  // Antigravity 分档别名 / 带后缀模型不支持额外 --effort
  assert.deepEqual(
    buildInteractiveAgentCommand(agCli, { permissionMode: 'auto', model: 'pro', effort: 'high' }),
    {
      cli: 'agy',
      args: ['--conversation', AG_CLI_ID, '--model', 'pro', '--mode', 'auto'],
      sessionId: AG_CLI_ID,
      model: 'pro',
      effort: null,
    },
  );
  assert.deepEqual(
    buildInteractiveAgentCommand(agCli, { permissionMode: 'edits', model: 'gemini-4-carbon-high', effort: 'high' }),
    {
      cli: 'agy',
      args: ['--conversation', AG_CLI_ID, '--model', 'gemini-4-carbon-high', '--mode', 'accept-edits'],
      sessionId: AG_CLI_ID,
      model: 'gemini-4-carbon-high',
      effort: null,
    },
  );

  assert.throws(() => buildInteractiveAgentCommand(claude, { model: 'bad model; rm -rf' }), (err) => (
    err instanceof TerminalLaunchError && err.code === 'invalid_model'
  ));
  assert.throws(() => buildInteractiveAgentCommand(claude, { model: '--help' }), (err) => (
    err instanceof TerminalLaunchError && err.code === 'invalid_model'
  ));
  assert.throws(() => buildInteractiveAgentCommand(agDesk), (err) => (
    err instanceof TerminalLaunchError && err.code === 'unsupported_terminal_session'
  ));
  assert.throws(() => buildInteractiveAgentCommand({ ...claude, providerId: 'bad;rm -rf /' }), (err) => (
    err instanceof TerminalLaunchError && err.code === 'invalid_session_id'
  ));
});

test('标题净化（含前导短横线）、控制字符检查、Win32/POSIX 转义与环境变量清理', () => {
  assert.equal(sanitizeTerminalTitle({ title: '修 bug;\r\n  第二行\t测试', agent: 'claude' }, '/repo'), '修 bug 第二行 测试');
  assert.equal(sanitizeTerminalTitle({ title: '--help fix login', agent: 'claude' }, '/repo'), 'help fix login');
  assert.equal(hasControlChars('/tmp/ok'), false);
  assert.equal(hasControlChars('/tmp/bad\x03dir'), true);
  assert.equal(hasControlChars('/tmp/bad\ndir'), true);
  assert.equal(win32QuoteArg('--resume'), '--resume');
  assert.equal(win32QuoteArg('C:\\Program Files\\a "b"\\'), '"C:\\Program Files\\a \\"b\\"\\\\"');
  assert.equal(posixQuote("/tmp/it's $(rm -rf) `id`"), "'/tmp/it'\\''s $(rm -rf) `id`'");

  let realpathTouched = false;
  const untouchedFs = {
    realpathSync: { native: (p) => { realpathTouched = true; return p; } },
    statSync: () => ({ isDirectory: () => true }),
  };
  assert.throws(() => resolveSessionCwd('/tmp/bad\x03dir', untouchedFs, 'linux'), (err) => (
    err instanceof TerminalLaunchError && err.code === 'invalid_cwd'
  ));
  for (const badCwd of ['.', 'subdir', '\\foo', '/foo', 'C:foo']) {
    assert.throws(() => resolveSessionCwd(badCwd, untouchedFs, 'win32'), (err) => (
      err instanceof TerminalLaunchError && err.code === 'invalid_cwd'
    ), `win32 resolveSessionCwd 必须拒绝 ${badCwd}`);
  }
  for (const badCwd of ['.', 'subdir', 'C:\\repo']) {
    assert.throws(() => resolveSessionCwd(badCwd, untouchedFs, 'linux'), (err) => (
      err instanceof TerminalLaunchError && err.code === 'invalid_cwd'
    ), `linux resolveSessionCwd 必须拒绝 ${badCwd}`);
  }
  assert.equal(realpathTouched, false, '拒绝非法/相对路径时不得接触文件系统或退回 daemon process.cwd()');

  const realTmp = tmpDir();
  assert.equal(resolveSessionCwd(realTmp).toLowerCase(), fs.realpathSync.native(realTmp).replace(/^\\\\\?\\(?=[a-z]:[\\/])/i, '').toLowerCase());

  const cleaned = cleanTerminalEnv({
    PATH: '/usr/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_HOST_SESSION_ID: 'abc',
    KEEP_ME: 'yes',
  });
  assert.equal(cleaned.KEEP_ME, 'yes');
  assert.equal('CLAUDECODE' in cleaned, false);
  assert.equal('CLAUDE_CODE_ENTRYPOINT' in cleaned, false);
  assert.equal('CLAUDE_CODE_HOST_SESSION_ID' in cleaned, false);
});

test('findWindowsPowerShell 优先使用 PowerShell 7，支持大小写无关的环境变量键名', () => {
  const pwsh7 = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const ps5 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  const with7 = findWindowsPowerShell({
    env: { PROGRAMW6432: 'C:\\Program Files', SYSTEMROOT: 'C:\\Windows' },
    fsOps: { statSync: (p) => ({ isFile: () => p === pwsh7 }) },
  });
  assert.equal(with7, pwsh7);

  const only5 = findWindowsPowerShell({
    env: { PROGRAMW6432: 'C:\\Program Files', SYSTEMROOT: 'C:\\Windows' },
    fsOps: {
      statSync: (p) => {
        if (p === ps5) return { isFile: () => true };
        throw new Error('ENOENT');
      },
    },
  });
  assert.equal(only5, ps5);
});

test('findPosixBinary 保留 Snap/Volta 符号链接 argv[0]，同时拦截工作目录内指向外部的符号链接并补充 node 目录', () => {
  const realMap = new Map([
    ['/home/dev/repo', '/home/dev/repo'],
    ['/home/dev/repo/bin', '/home/dev/repo/bin'],
    ['/home/dev/repo/bin/claude', '/usr/bin/fake-external'],
    ['/snap/bin', '/snap/bin'],
    ['/snap/bin/kitty', '/usr/bin/snap'],
    ['/home/dev/.volta/bin', '/home/dev/.volta/bin'],
    ['/home/dev/.volta/bin/claude', '/home/dev/.volta/bin/volta-shim'],
    ['/opt/nvm/bin', '/opt/nvm/bin'],
    ['/opt/nvm/bin/codex', '/opt/nvm/bin/codex'],
  ]);
  const files = new Set(['/usr/bin/fake-external', '/usr/bin/snap', '/home/dev/.volta/bin/volta-shim', '/opt/nvm/bin/codex']);
  const fsOps = {
    realpathSync: {
      native(p) {
        if (realMap.has(p)) return realMap.get(p);
        throw new Error('ENOENT');
      },
    },
    statSync(p) {
      if (files.has(p)) return { isFile: () => true };
      throw new Error('ENOENT');
    },
    accessSync() {},
  };

  // 工作目录内的符号链接即使指向 /usr/bin 也必须被拦截，最终命中 Volta 符号链接并保留原入口路径
  assert.equal(
    findPosixBinary('claude', {
      env: { PATH: '/home/dev/repo/bin:/home/dev/.volta/bin' },
      cwd: '/home/dev/repo',
      home: '/home/dev',
      execDir: '/usr/bin',
      fsOps,
    }),
    '/home/dev/.volta/bin/claude',
  );

  // Snap 终端必须保留 /snap/bin/kitty 而不是解析成 /usr/bin/snap
  assert.equal(
    findPosixBinary('kitty', {
      env: { PATH: '/snap/bin' },
      cwd: '/home/dev/repo',
      home: '/home/dev',
      execDir: '/usr/bin',
      fsOps,
    }),
    '/snap/bin/kitty',
  );

  // launchd/systemd 最小 PATH 下回退搜索 node 所在目录（nvm/fnm 等）
  assert.equal(
    findPosixBinary('codex', {
      env: { PATH: '/usr/bin:/bin' },
      cwd: '/home/dev/repo',
      home: '/home/dev',
      execDir: '/opt/nvm/bin',
      fsOps,
    }),
    '/opt/nvm/bin/codex',
  );
});

test('buildTerminalLaunchSpec 为 Windows、macOS 与 Linux 生成安全启动规格', () => {
  // Windows 经 PowerShell Start-Process + UTF-8 JSON stdin，且 stdout 忽略不堵管
  const win = buildTerminalLaunchSpec({
    platform: 'win32',
    cwd: 'C:\\work\\中文 空格;dir',
    executable: 'C:\\Users\\demo\\.local\\bin\\claude.exe',
    agentArgs: ['--resume', CLAUDE_ID],
    title: 'Fix bug',
    env: { SystemRoot: 'C:\\Windows' },
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  });
  assert.equal(win.terminal, 'windows-terminal');
  assert.equal(win.command, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe');
  assert.equal(win.options.shell, false);
  assert.deepEqual(win.options.stdio, ['pipe', 'ignore', 'pipe']);
  assert.equal(win.waitForExit, true);
  assert.ok(win.args.at(-1).includes('[Console]::OutputEncoding = $utf8'));
  assert.deepEqual(JSON.parse(win.stdin), {
    filePath: 'C:\\Users\\demo\\.local\\bin\\claude.exe',
    cwd: 'C:\\work\\中文 空格;dir',
    argString: `--resume ${CLAUDE_ID}`,
  });

  // macOS Terminal.app：osascript 绝对路径、env 清理嵌套变量、代理透传与控制字符拦截
  const mac = buildTerminalLaunchSpec({
    platform: 'darwin',
    cwd: "/Users/dev/it's $(evil)",
    executable: '/opt/homebrew/bin/agy',
    agentArgs: ['--conversation', AG_CLI_ID],
    agent: 'antigravity',
    title: 'Mac task',
    env: { HTTPS_PROXY: 'http://127.0.0.1:7890', https_proxy: 'http://127.0.0.1:7891' },
    findPosixBin: () => '/usr/bin/osascript',
  });
  assert.equal(mac.terminal, 'Terminal.app');
  assert.equal(mac.command, '/usr/bin/osascript');
  assert.equal(mac.waitForExit, true);
  assert.equal(mac.options.shell, false);
  assert.deepEqual(mac.options.stdio, ['ignore', 'ignore', 'pipe']);
  const macCmd = mac.args.at(-1);
  assert.ok(macCmd.startsWith("cd -- '/Users/dev/it'\\''s $(evil)' && 'env' '-u' 'CLAUDECODE' "));
  assert.ok(macCmd.includes("'HTTPS_PROXY=http://127.0.0.1:7890'"));
  assert.ok(macCmd.includes("'https_proxy=http://127.0.0.1:7891'"));
  assert.ok(macCmd.endsWith(`'/opt/homebrew/bin/agy' '--conversation' '${AG_CLI_ID}'`));

  // macOS 控制字符注入（如 Ctrl-C \x03）必须被拒绝
  assert.throws(() => buildTerminalLaunchSpec({
    platform: 'darwin',
    cwd: '/Users/dev/bad\x03dir',
    executable: '/opt/homebrew/bin/claude',
    agentArgs: ['--resume', CLAUDE_ID],
    title: 'Bad',
    env: {},
    findPosixBin: () => '/usr/bin/osascript',
  }), (err) => err instanceof TerminalLaunchError && err.code === 'invalid_terminal_args');

  // Linux 桌面终端：使用 --title= 避免短横线参数误判
  const lin = buildTerminalLaunchSpec({
    platform: 'linux',
    cwd: '/home/dev/repo',
    executable: '/usr/local/bin/codex',
    agentArgs: ['resume', CODEX_ID],
    title: 'Linux task',
    env: { DISPLAY: ':0' },
    findLinTerminal: () => ({
      name: 'kitty',
      bin: '/usr/bin/kitty',
      args: (cwd, title, cmd) => ['--directory', cwd, `--title=${title}`, ...cmd],
    }),
  });
  assert.equal(lin.terminal, 'kitty');
  assert.equal(lin.command, '/usr/bin/kitty');
  assert.deepEqual(lin.args, ['--directory', '/home/dev/repo', '--title=Linux task', '/usr/local/bin/codex', 'resume', CODEX_ID]);

  // Linux 无图形桌面报错
  assert.throws(() => buildTerminalLaunchSpec({
    platform: 'linux',
    cwd: '/home/dev/repo',
    executable: '/usr/local/bin/claude',
    agentArgs: ['--resume', CLAUDE_ID],
    title: 'Headless',
    env: {},
  }), (err) => err instanceof TerminalLaunchError && err.code === 'terminal_unavailable' && err.status === 503);

  // Linux PATH 无任何终端报错
  assert.throws(() => buildTerminalLaunchSpec({
    platform: 'linux',
    cwd: '/home/dev/repo',
    executable: '/usr/local/bin/claude',
    agentArgs: ['--resume', CLAUDE_ID],
    title: 'No term',
    env: { WAYLAND_DISPLAY: 'wayland-0' },
    findLinTerminal: () => null,
  }), (err) => err instanceof TerminalLaunchError && err.code === 'terminal_unavailable' && err.status === 503);
});

test('findLinuxTerminal 发现 PATH 中的终端并生成安全的 --title= 参数', () => {
  const okFs = {
    realpathSync: { native: (p) => p },
    statSync: (p) => {
      if (p === '/usr/bin/kitty' || p === '/home/dev/repo/ghostty') return { isFile: () => true };
      throw new Error('ENOENT');
    },
    accessSync: () => {},
  };
  const found = findLinuxTerminal({
    env: { PATH: '/home/dev/repo:/usr/bin' },
    cwd: '/home/dev/repo',
    home: '/home/dev',
    fsOps: okFs,
  });
  assert.equal(found?.name, 'kitty');
  assert.equal(found?.bin, '/usr/bin/kitty');
  assert.deepEqual(found.args('/repo', 'demo', ['/bin/claude']), ['--directory', '/repo', '--title=demo', '/bin/claude']);
});

test('launchLocalTerminal 自动读取 Baton 落盘的权限、模型与思考强度设置（含 defaultEffort）', async () => {
  const cwd = 'C:\\work\\prefs-demo';
  const batonDir = tmpDir();
  const key = 'claude:demo-session';
  const member = { key, agent: 'claude', providerId: CLAUDE_ID, cwd, title: 'Prefs demo' };
  const passWinCwd = (c) => c;

  fs.writeFileSync(path.join(batonDir, 'config.json'), JSON.stringify({
    permissionMode: { claude: 'bypass', codex: 'edits' },
    defaultEffort: { claude: 'max' },
  }));

  const captureSpawn = (captured) => () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      captured.push(JSON.parse(String(data ?? '')));
      queueMicrotask(() => child.emit('close', 0));
    };
    child.kill = () => {};
    return child;
  };

  // 1. 未选会话模型与强度时，沿用 config.json 的 permissionMode + defaultEffort
  const firstRun = [];
  const res1 = await launchLocalTerminal({
    member,
    batonDir,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(firstRun),
  });
  assert.equal(res1.permissionMode, 'bypass');
  assert.equal(res1.model, null);
  assert.equal(res1.effort, 'max');
  assert.equal(firstRun[0].argString, `--resume ${CLAUDE_ID} --dangerously-skip-permissions --effort max`);

  // 2. 会话单独选了模型与强度时，优先使用会话自己的 prefs.json
  fs.writeFileSync(path.join(batonDir, 'prefs.json'), JSON.stringify({
    [key]: { model: 'claude-sonnet-4-6', effort: 'high', updatedAt: Date.now() },
  }));
  const secondRun = [];
  const res2 = await launchLocalTerminal({
    member,
    batonDir,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(secondRun),
  });
  assert.equal(res2.permissionMode, 'bypass');
  assert.equal(res2.model, 'claude-sonnet-4-6');
  assert.equal(res2.effort, 'high');
  assert.equal(
    secondRun[0].argString,
    `--resume ${CLAUDE_ID} --model claude-sonnet-4-6 --dangerously-skip-permissions --effort high`,
  );

  // 3. 只选了模型、未选强度时，不得把配给默认模型的 defaultEffort 强加到新模型上
  fs.writeFileSync(path.join(batonDir, 'prefs.json'), JSON.stringify({
    [key]: { model: 'claude-sonnet-4-6', updatedAt: Date.now() },
  }));
  const thirdRun = [];
  const res3 = await launchLocalTerminal({
    member,
    batonDir,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(thirdRun),
  });
  assert.equal(res3.model, 'claude-sonnet-4-6');
  assert.equal(res3.effort, null);
  assert.equal(thirdRun[0].argString, `--resume ${CLAUDE_ID} --model claude-sonnet-4-6 --dangerously-skip-permissions`);

  // 4. prefs.json 里 effort 被破坏且 model 未选时，回退到 defaultEffort；model="" 归一化为 null；旧标量 permissionMode 生效
  fs.writeFileSync(path.join(batonDir, 'config.json'), JSON.stringify({
    permissionMode: 'bypass',
    defaultEffort: { claude: 'max' },
  }));
  fs.writeFileSync(path.join(batonDir, 'prefs.json'), JSON.stringify({
    [key]: { effort: 'bogus; rm -rf', updatedAt: Date.now() },
  }));
  const fourthRun = [];
  const res4 = await launchLocalTerminal({
    member,
    batonDir,
    model: '',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(fourthRun),
  });
  assert.equal(res4.permissionMode, 'bypass');
  assert.equal(res4.model, null);
  assert.equal(res4.effort, 'max');
  assert.equal(fourthRun[0].argString, `--resume ${CLAUDE_ID} --dangerously-skip-permissions --effort max`);

  // 5. 跨 agent 不存在的权限档位退回 default；损坏的模型名直接报 invalid_model
  const fifthRun = [];
  const res5 = await launchLocalTerminal({
    member,
    batonDir,
    permissionMode: 'read',
    model: null,
    effort: null,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(fifthRun),
  });
  assert.equal(res5.permissionMode, 'default');
  assert.equal(fifthRun[0].argString, `--resume ${CLAUDE_ID}`);

  fs.writeFileSync(path.join(batonDir, 'prefs.json'), JSON.stringify({
    [key]: { model: 'bad model; oops', updatedAt: Date.now() },
  }));
  await assert.rejects(() => launchLocalTerminal({
    member,
    batonDir,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn([]),
  }), (err) => err instanceof TerminalLaunchError && err.code === 'invalid_model');

  // 6. Codex 与 Antigravity CLI 沿用设置（含 Antigravity 分档模型忽略 effort）
  const codexRun = [];
  const codexRes = await launchLocalTerminal({
    member: { key: 'codex:demo', agent: 'codex', providerId: CODEX_ID, cwd, title: 'Codex' },
    batonDir,
    permissionMode: 'edits',
    model: 'gpt-5.4',
    effort: 'ultra',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\codex.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(codexRun),
  });
  assert.equal(codexRes.permissionMode, 'edits');
  assert.equal(codexRes.effort, 'ultra');
  assert.equal(codexRun[0].argString, `resume --model gpt-5.4 --sandbox workspace-write -c model_reasoning_effort=ultra ${CODEX_ID}`);

  const agRun = [];
  const agRes = await launchLocalTerminal({
    member: {
      key: 'antigravity:demo',
      agent: 'antigravity',
      providerId: AG_CLI_ID,
      cwd,
      relPath: `antigravity-cli/brain/${AG_CLI_ID}/.system_generated/logs/transcript.jsonl`,
    },
    batonDir,
    permissionMode: 'bypass',
    model: 'pro',
    effort: 'high',
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passWinCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\agy.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: captureSpawn(agRun),
  });
  assert.equal(agRes.permissionMode, 'bypass');
  assert.equal(agRes.model, 'pro');
  assert.equal(agRes.effort, null);
  assert.equal(agRun[0].argString, `--conversation ${AG_CLI_ID} --model pro --dangerously-skip-permissions`);
});

test('launchLocalTerminal 正确处理 Windows stdin、Linux 独立拉起、信号崩溃与 macOS 退出码', async () => {
  const winMember = { agent: 'claude', providerId: CLAUDE_ID, cwd: 'C:\\work\\demo', title: 'Demo session' };
  const posixMember = { agent: 'claude', providerId: CLAUDE_ID, cwd: '/home/dev/demo', title: 'Demo session' };
  const passCwd = (c) => c;

  // Windows 成功场景（校验 stdin 收到完整 JSON 载荷）
  let receivedStdin = '';
  const winOkSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (data) => {
      receivedStdin = String(data ?? '');
      queueMicrotask(() => child.emit('close', 0));
    };
    child.kill = () => {};
    return child;
  };
  const winRes = await launchLocalTerminal({
    member: winMember,
    platform: 'win32',
    env: { SystemRoot: 'C:\\Windows' },
    resolveCwd: passCwd,
    resolveBinary: async () => ({ executable: 'C:\\bin\\claude.exe', env: { SystemRoot: 'C:\\Windows' } }),
    findWinPowerShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    spawnFn: winOkSpawn,
  });
  assert.equal(winRes.ok, true);
  assert.equal(winRes.terminal, 'windows-terminal');
  assert.equal(JSON.parse(receivedStdin).filePath, 'C:\\bin\\claude.exe');

  // Linux 独立进程成功 + unref
  let unrefCalled = false;
  const linuxOkSpawn = () => {
    const child = new EventEmitter();
    child.unref = () => { unrefCalled = true; };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const linRes = await launchLocalTerminal({
    member: posixMember,
    platform: 'linux',
    env: { DISPLAY: ':0' },
    resolveCwd: passCwd,
    resolveBinary: async () => ({ executable: '/usr/local/bin/claude', env: { DISPLAY: ':0' } }),
    findLinTerminal: () => ({ name: 'kitty', bin: '/usr/bin/kitty', args: (_c, _t, cmd) => cmd }),
    spawnFn: linuxOkSpawn,
    graceMs: 10,
  });
  assert.equal(linRes.ok, true);
  assert.equal(linRes.terminal, 'kitty');
  assert.equal(unrefCalled, true);

  // Linux 启动后立即被信号杀死（code=null, signal='SIGSEGV'）必须报错
  const signalCrashSpawn = () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => {
      child.emit('spawn');
      child.emit('close', null, 'SIGSEGV');
    });
    return child;
  };
  await assert.rejects(() => launchLocalTerminal({
    member: posixMember,
    platform: 'linux',
    env: { DISPLAY: ':0' },
    resolveCwd: passCwd,
    resolveBinary: async () => ({ executable: '/usr/local/bin/claude', env: { DISPLAY: ':0' } }),
    findLinTerminal: () => ({ name: 'kitty', bin: '/usr/bin/kitty', args: (_c, _t, cmd) => cmd }),
    spawnFn: signalCrashSpawn,
    graceMs: 50,
  }), (err) => err instanceof TerminalLaunchError && err.code === 'terminal_launch_failed' && err.message.includes('SIGSEGV'));

  // macOS osascript 返回非零并带 stderr
  const macFailSpawn = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('Not authorized to send Apple events to Terminal.'));
      child.emit('close', 1);
    });
    return child;
  };
  await assert.rejects(() => launchLocalTerminal({
    member: posixMember,
    platform: 'darwin',
    env: {},
    resolveCwd: passCwd,
    resolveBinary: async () => ({ executable: '/usr/local/bin/claude', env: {} }),
    findPosixBin: () => '/usr/bin/osascript',
    spawnFn: macFailSpawn,
  }), (err) => err instanceof TerminalLaunchError && err.message.includes('Not authorized'));
});

test('HTTP 集成：/api/health、/api/sessions 与 POST /api/sessions/:key/terminal 完整权限与错误处理', async () => {
  const claudeRoot = tmpDir();
  const codexRoot = tmpDir();
  const geminiRoot = tmpDir();
  const realCwd = tmpDir();
  const guestRoot = tmpDir();
  const realCwdUri = pathToFileURL(realCwd).href;

  writeJsonl(claudeRoot, path.join('proj-a', `${CLAUDE_ID}.jsonl`), [
    {
      type: 'user', sessionId: CLAUDE_ID, uuid: 'u1', cwd: realCwd, timestamp: '2026-11-20T00:00:00Z',
      message: { role: 'user', content: 'Claude 测试' },
    },
  ]);
  writeJsonl(claudeRoot, path.join('proj-guest', 'aaaaaaaa-0000-0000-0000-000000000099.jsonl'), [
    {
      type: 'user', sessionId: 'aaaaaaaa-0000-0000-0000-000000000099', uuid: 'u2', cwd: guestRoot, timestamp: '2026-11-20T00:00:00Z',
      message: { role: 'user', content: '访客会话' },
    },
  ]);
  writeJsonl(codexRoot, path.join('2026', '11', '20', `rollout-2026-11-20T00-00-00-${CODEX_ID}.jsonl`), [
    {
      timestamp: '2026-11-20T00:00:00Z', type: 'session_meta',
      payload: { id: CODEX_ID, cwd: realCwd, origin: 'cli', source: 'cli' },
    },
    {
      timestamp: '2026-11-20T00:00:01Z', type: 'event_msg',
      payload: { type: 'user_message', message: 'Codex 测试' },
    },
  ]);
  // 为 Antigravity 桌面端与 CLI 都写入真实摘要库（确保 cwd 非空，真正测到产品区分）
  createSummaryDb(path.join(geminiRoot, 'antigravity', 'conversation_summaries.db'), [
    { id: AG_DESKTOP_ID, title: 'Desktop AG', uris: [realCwdUri] },
  ]);
  createSummaryDb(path.join(geminiRoot, 'antigravity-cli', 'conversation_summaries.db'), [
    { id: AG_CLI_ID, title: 'CLI AG', uris: [realCwdUri] },
  ]);
  writeJsonl(geminiRoot, path.join('antigravity', 'brain', AG_DESKTOP_ID, '.system_generated', 'logs', 'transcript.jsonl'), [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z', content: 'Desktop AG' },
  ]);
  writeJsonl(geminiRoot, path.join('antigravity-cli', 'brain', AG_CLI_ID, '.system_generated', 'logs', 'transcript.jsonl'), [
    { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-20T00:00:00Z', content: 'CLI AG' },
  ]);

  const stateFile = path.join(tmpDir(), 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ 'electron-persisted-atom-state': { 'thread-descriptions-v1': {} } }));

  const repo = createRepo({ claudeRoot, codexRoot, geminiRoot, registryRoot: tmpDir(), codexStateFile: stateFile });
  const guest = { id: 'friend', name: 'Friend', roots: [guestRoot], allowSend: true };
  const auth = createAuth({ token: TOKEN, principals: [OWNER, guest] });
  const guestCode = auth.newPairingCode('friend');
  const guestPair = auth.verifyPair(guestCode, { secure: false });
  assert.equal(guestPair.ok, true);

  const launched = [];
  const server = createServer({
    repo,
    auth,
    config: { host: '127.0.0.1', port: 0, allowSend: false },
    terminalLauncher: async ({ member }) => {
      const cmd = buildInteractiveAgentCommand(member, { permissionMode: 'bypass', model: 'test-model', effort: 'high' });
      launched.push({ agent: member.agent, cli: cmd.cli, args: cmd.args, cwd: member.cwd });
      return {
        ok: true,
        terminal: 'mock-term',
        agent: member.agent,
        cwd: member.cwd,
        sessionId: member.providerId,
        permissionMode: 'bypass',
        model: cmd.model,
        effort: cmd.effort,
      };
    },
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const ownerHeaders = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const guestHeaders = { Authorization: `Bearer ${guestPair.bearer}`, 'content-type': 'application/json' };

  try {
    // 1. /api/health 本地 owner -> isLocal: true, canOpenTerminal: true
    const ownerHealth = await (await fetch(`${base}/api/health`, { headers: ownerHeaders })).json();
    assert.equal(ownerHealth.isLocal, true);
    assert.equal(ownerHealth.canOpenTerminal, true);

    // 2. /api/health 经代理头 -> isLocal: false, canOpenTerminal: false
    const proxiedHealth = await (await fetch(`${base}/api/health`, {
      headers: { ...ownerHeaders, 'x-forwarded-for': '203.0.113.5' },
    })).json();
    assert.equal(proxiedHealth.isLocal, false);
    assert.equal(proxiedHealth.canOpenTerminal, false);

    // 3. /api/health 访客 -> isLocal: true, canOpenTerminal: false
    const guestHealth = await (await fetch(`${base}/api/health`, { headers: guestHeaders })).json();
    assert.equal(guestHealth.isLocal, true);
    assert.equal(guestHealth.canOpenTerminal, false);

    // 4. /api/sessions 中各会话的 cwd 与 supportsTerminal 标记正确（含 Antigravity CLI vs Desktop 区分）
    const list = await (await fetch(`${base}/api/sessions`, { headers: ownerHeaders })).json();
    const all = list.chains.flatMap((c) => c.members);
    const claudeMember = all.find((m) => m.providerId === CLAUDE_ID);
    const codexMember = all.find((m) => m.providerId === CODEX_ID);
    const agCliMember = all.find((m) => m.providerId === AG_CLI_ID);
    const agDeskMember = all.find((m) => m.providerId === AG_DESKTOP_ID);
    const guestMember = all.find((m) => m.providerId === 'aaaaaaaa-0000-0000-0000-000000000099');
    assert.equal(claudeMember?.supportsTerminal, true);
    assert.equal(codexMember?.supportsTerminal, true);
    assert.ok(agCliMember?.cwd, 'Antigravity CLI fixture 必须有真实 cwd');
    assert.ok(agDeskMember?.cwd, 'Antigravity Desktop fixture 必须有真实 cwd');
    assert.equal(agCliMember?.supportsTerminal, true);
    assert.equal(agDeskMember?.supportsTerminal, false);

    // 5. 本地 owner 即使 allowSend=false（只读模式）也可打开 Claude / Codex / Antigravity CLI 本地终端
    const okClaude = await fetch(`${base}/api/sessions/${encodeURIComponent(claudeMember.key)}/terminal`, {
      method: 'POST', headers: ownerHeaders, body: '{}',
    });
    assert.equal(okClaude.status, 200);
    assert.deepEqual(await okClaude.json(), {
      ok: true, terminal: 'mock-term', agent: 'claude', cwd: realCwd, sessionId: CLAUDE_ID,
      permissionMode: 'bypass', model: 'test-model', effort: 'high',
    });
    const auditLog = fs.readFileSync(path.join(process.env.BATON_DIR, 'audit.log'), 'utf8');
    assert.ok(auditLog.includes('"type":"open_terminal"'));
    assert.ok(auditLog.includes('"permissionMode":"bypass"'));
    assert.ok(auditLog.includes('"model":"test-model"'));
    assert.ok(auditLog.includes('"effort":"high"'));

    const okCodex = await fetch(`${base}/api/sessions/${encodeURIComponent(codexMember.key)}/terminal`, {
      method: 'POST', headers: ownerHeaders, body: '{}',
    });
    assert.equal(okCodex.status, 200);

    const okAgCli = await fetch(`${base}/api/sessions/${encodeURIComponent(agCliMember.key)}/terminal`, {
      method: 'POST', headers: ownerHeaders, body: '{}',
    });
    assert.equal(okAgCli.status, 200);
    assert.deepEqual(launched.map((x) => x.cli), ['claude', 'codex', 'agy']);

    // 6. 代理/隧道访问被 403 local_only 拦截
    const blockedProxy = await fetch(`${base}/api/sessions/${encodeURIComponent(claudeMember.key)}/terminal`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'cf-connecting-ip': '198.51.100.7' },
      body: '{}',
    });
    assert.equal(blockedProxy.status, 403);
    assert.equal((await blockedProxy.json()).error.code, 'local_only');

    // 7. 访客被 403 owner_only 拦截
    const blockedGuest = await fetch(`${base}/api/sessions/${encodeURIComponent(guestMember.key)}/terminal`, {
      method: 'POST', headers: guestHeaders, body: '{}',
    });
    assert.equal(blockedGuest.status, 403);
    assert.equal((await blockedGuest.json()).error.code, 'owner_only');

    // 8. Antigravity 桌面会话（有 cwd 但非 CLI）返回 400 unsupported_terminal_session
    const blockedAg = await fetch(`${base}/api/sessions/${encodeURIComponent(agDeskMember.key)}/terminal`, {
      method: 'POST', headers: ownerHeaders, body: '{}',
    });
    assert.equal(blockedAg.status, 400);
    assert.equal((await blockedAg.json()).error.code, 'unsupported_terminal_session');

    // 9. 不存在的会话返回 404 unknown_session
    const notFound = await fetch(`${base}/api/sessions/${encodeURIComponent('claude:missing')}/terminal`, {
      method: 'POST', headers: ownerHeaders, body: '{}',
    });
    assert.equal(notFound.status, 404);
    assert.equal((await notFound.json()).error.code, 'unknown_session');

    // 10. 跨站 cookie POST 被 403 cross_origin 拦截
    const ownerPair = auth.verifyPair(auth.newPairingCode('owner'), { secure: false });
    const cookie = ownerPair.setCookie.split(';')[0];
    const csrf = await fetch(`${base}/api/sessions/${encodeURIComponent(claudeMember.key)}/terminal`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(csrf.status, 403);
    assert.equal((await csrf.json()).error.code, 'cross_origin');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
