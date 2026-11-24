#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, ensureToken, BATON_DIR } from './config.js';
import { createRepo } from './repo.js';
import { loadPrincipals, ensureRoots, OWNER_ID, revokedQueueGrant } from './principals.js';
import { createAuth } from './http/auth.js';
import { fileRevocations } from './revocations.js';
import { fileDevices } from './devices.js';
import { createServer } from './http/server.js';
import { missingCredentials, CREDENTIAL_FIX } from './agent/preflight.js';
import { reconcileOrphans } from './runtime/intents.js';
import { ownedProcessAlive, reconcileRunning, recoverTurn, updateTurnControl } from './runtime/turns.js';
import { recoveryBirthLookup } from './runtime/processIdentity.js';
import { acquireInstance, shutdownExecutions } from './runtime/instance.js';
import { unboundCreationRecovery } from './runtime/creations.js';
import { desktopRecovery } from './agent/antigravityRun.js';
import { claudeDefaults } from './agent/defaults.js';
import { antigravityCatalog } from './agent/catalog.js';
import { codexSandboxState } from './agent/sandbox.js';
import { installGuards } from './runtime/guards.js';
import { reconcileQueues, watchQueues } from './http/handlers/turns.js';
import { reconcilePrefs, getDefaultEffort } from './runtime/prefs.js';
import { reconcileAsks } from './ask/store.js';
import { reconcileAskConfigs } from './ask/setup.js';
import { pickWebRoot } from './http/static.js';
import { ensureAntigravityPlugin } from './agent/antigravityBridge.js';
import { parseCliArgs, USAGE } from './cli-args.js';
import { VERSION } from './version.js';
import { runDoctor } from './doctor.js';
import { runPairCommand } from './pair-client.js';
import { startQuickTunnel } from './tunnel.js';
import { encode, toSvg } from './qr.js';
import { pickNetworkAddresses, formatHttpUrl } from './lan.js';

function printDoctorHuman(report) {
  console.log('');
  console.log(`  Baton v${report.version} (${report.platform})`);
  console.log('');
  for (const c of report.checks) {
    const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '!' : '✗';
    console.log(`  ${icon} ${c.id.padEnd(16)} ${c.detail}`);
    if (c.fix) console.log(`    ${' '.repeat(16)} ${c.fix}`);
  }
  console.log('');
}

async function runDaemon(opts) {
  // 最先装：之后任何一处漏网的 Promise 拒绝都不该把整个守护进程带走（见 runtime/guards.js）
  installGuards();

  let lease;
  try { lease = acquireInstance(BATON_DIR); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const baseConfig = loadConfig();
  const config = {
    ...baseConfig,
    ...(opts.host ? { host: opts.host } : {}),
    ...(opts.port ? { port: opts.port } : {}),
    ...(opts.readOnly ? { allowSend: false } : {}),
  };
  const token = ensureToken();
  // repo 在这里保持未包装：reconcile* 作业需要跨全部身份清理状态
  const repo = createRepo();
  const { principals, errors: principalErrors } = loadPrincipals({ manageGenerations: true });
  const auth = createAuth({
    token,
    principals,
    revokedQueueGrant,
    revocations: fileRevocations(path.join(BATON_DIR, 'revoked.json')),
    devices: fileDevices(path.join(BATON_DIR, 'devices.json')),
  });
  const guestRoots = ensureRoots(principals);
  const server = createServer({ repo, auth, config });

  let tunnelHandle = null;
  let stopWatch = () => {};
  let recoveryTimer = null;
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      server.closeAllConnections?.();
      return;
    }
    shuttingDown = true;
    stopWatch();
    clearInterval(recoveryTimer);
    try {
      tunnelHandle?.stop();
    } catch {
      // ignore
    }
    server.closeIdleConnections?.();
    const force = setTimeout(() => {
      server.closeAllConnections?.();
    }, 3000);
    force.unref?.();
    const httpClosed = new Promise((resolve) => server.close(resolve));
    await Promise.all([httpClosed, shutdownExecutions()]);
    clearTimeout(force);
    lease.release();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  server.listen(config.port, config.host, async () => {
    if (process.platform === 'win32' && process.env.BATON_WATCHDOG_MANAGED === '1') {
      const pwsh = path.join(process.env.ProgramW6432 || process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
      const register = fileURLToPath(new URL('../scripts/register-daemon.ps1', import.meta.url));
      execFile(pwsh, ['-NoProfile', '-NonInteractive', '-File', register, '-NodeId', String(process.pid),
        '-DataDir', BATON_DIR, '-EntryPath', fileURLToPath(import.meta.url), '-Port', String(config.port), '-Address', config.host],
      { windowsHide: true, timeout: 10000 }, (error) => {
        if (error) console.warn('无法登记 Windows 守护进程，看门狗将跳过终止操作。');
      });
    }
    const inspectMonitor = desktopRecovery(repo, { onCheckpoint: (turn, monitor) => updateTurnControl(turn.key, turn.turnId, { monitor }) });
    const birthOf = recoveryBirthLookup();
    const alive = (pid, turn) => ownedProcessAlive(pid, turn, { birthOf });
    const retained = new Map();
    const pendingScans = new Set();
    const reclaimed = reconcileOrphans({ isAlive: (_id, turn) => turn?.status === 'running' && (turn.canStop === false || alive(turn.childPid, turn)) });
    const recover = (key = null) => reconcileRunning({ key, alive, inspectMonitor, onRetained: (turn) => retained.set(turn.turnId, turn),
      onScanError: (failedKey) => pendingScans.add(failedKey) });
    const interrupted = recover();
    const observeCreations = unboundCreationRecovery(repo, { principalOf: auth.principalOf, onBound: (turn) => retained.set(turn.turnId, turn) });
    let unbound = observeCreations();
    if (retained.size || pendingScans.size || unbound) {
      recoveryTimer = setInterval(() => {
        if (unbound) unbound = observeCreations();
        const retryKeys = Array.from(pendingScans);
        pendingScans.clear();
        for (const key of retryKeys) recover(key);
        for (const [id, turn] of retained) {
          try { if (recoverTurn(turn, { alive, inspectMonitor })) retained.delete(id); } catch { /* 下次检查重试 */ }
        }
        if (!retained.size && !pendingScans.size && !unbound) clearInterval(recoveryTimer);
      }, 1000);
      recoveryTimer.unref();
    }
    reconcileAsks();
    reconcileAskConfigs();
    void claudeDefaults({ effort: getDefaultEffort('claude') });
    void antigravityCatalog();
    void codexSandboxState();
    try {
      const agPlugin = ensureAntigravityPlugin();
      if (agPlugin.changed) console.log(`  已更新插件 ${agPlugin.destDir}`);
    } catch {
      // 非致命
    }

    const code = auth.newPairingCode();
    const net = pickNetworkAddresses(os.networkInterfaces());
    console.log('');
    console.log(`  Baton v${VERSION} 已启动`);
    console.log(`  本机地址   ${formatHttpUrl(config.host, config.port)}`);
    if (net.lan) console.log(`  局域网     ${formatHttpUrl(net.lan, config.port)}`);
    if (net.tailscale) console.log(`  Tailscale  ${formatHttpUrl(net.tailscale, config.port)}`);
    console.log(`  配对码     ${code}    （10 分钟内有效，一次性）`);
    console.log('  再要一个   baton pair   或 npm run pair');
    console.log(`  发送开关   allowSend = ${config.allowSend}${config.allowSend ? '' : '   ← 只读模式'}`);
    console.log(`  数据目录   ${BATON_DIR}`);
    console.log(`  工作区根   ${config.workspacesRoot}`);

    for (const e of principalErrors) console.log(`  ⚠ principals.json：${e}`);
    const guests = principals.filter((p) => p.id !== OWNER_ID);
    if (guests.length === 0) {
      console.log(`  访客       无。要加人：在 ${path.join(BATON_DIR, 'principals.json')} 写`
        + ' {"guests":[{"id":"friend"}]} 后重启本进程。');
    }
    for (const g of guests) {
      const r = guestRoots.find((x) => x.id === g.id);
      const root = r?.root ?? g.roots[0];
      let mark = '';
      if (r?.error) mark = `   ⚠ 建不出来：${r.error}`;
      else if (r?.created) mark = '   ← 刚建出来';
      console.log(`  访客 ${g.id.padEnd(10)} ${root}   allowSend = ${g.allowSend ?? config.allowSend}${mark}`);
      console.log(`             取配对码：baton pair --for ${g.id}`);
    }

    const desktop = pickWebRoot({ mobile: false });
    const phone = pickWebRoot({ mobile: true });
    if (desktop.kind === phone.kind) {
      console.log('  浏览器界面 ' + ({
        spa: 'web/dist（浏览器专用客户端）',
        expo: 'app/dist（Expo 导出）  ← web/dist 不存在，跑 npm run web:build 生成',
        legacy: 'src/web（v1 老界面）  ← web/dist 与 app/dist 都不存在',
      })[desktop.kind]);
    } else {
      console.log('  浏览器界面 按设备分流');
      console.log('    电脑     web/dist（浏览器专用客户端）');
      console.log('    手机     app/dist（Expo 导出，为触摸写的那套）');
      console.log('    依据是 User-Agent，「请求桌面版网站」会把它翻过来');
    }
    if (config.devCorsOrigin) {
      console.log(`  ⚠ 跨源放行 ${config.devCorsOrigin}   ← 开发用，验收完请从 config.json 删掉`);
    }
    if (reclaimed.length) console.log(`  已回收     ${reclaimed.length} 个上次遗留的未结束轮次（标记为已停止）`);
    if (interrupted.length) console.log(`  已收尾     ${interrupted.length} 个上次没跑完的轮次（守护进程中途退出，标记为失败）`);
    console.log('');

    if (opts.quickTunnel) {
      try {
        const localHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host;
        tunnelHandle = await startQuickTunnel({ targetUrl: formatHttpUrl(localHost, config.port) });
        config.publicUrl = tunnelHandle.url;
        const link = `${tunnelHandle.url}/pair?c=${code}`;
        const qrFile = path.join(BATON_DIR, 'pairing-qr.svg');
        fs.writeFileSync(qrFile, toSvg(encode(link), { quiet: 4, scale: 20 }), { encoding: 'utf8', mode: 0o600 });
        console.log(`  Quick Tunnel  ${tunnelHandle.url}`);
        console.log(`  Pairing URL   ${link}`);
        console.log(`  QR SVG        ${qrFile}`);
        console.log('');
      } catch (err) {
        console.error(`  ⚠ Quick Tunnel failed: ${err.message}`);
      }
    }

    try {
      const gone = reconcilePrefs({ repo });
      if (gone.length) console.log(`  已清理     ${gone.length} 条已不存在会话的模型偏好\n`);
    } catch {
      // ignore
    }

    if (shuttingDown) return;
    reconcileQueues({ repo, config, principalOf: auth.principalOf })
      .then((resumed) => {
        const sent = resumed.filter((r) => r.sent).length;
        const dropped = resumed.filter((r) => r.dropped).length;
        if (sent) console.log(`  已续发     ${sent} 个会话里上次排队未发出的消息\n`);
        if (dropped) console.log(`  已清理     ${dropped} 个会话已不存在的遗留队列\n`);
      })
      .catch((err) => {
        console.log(`  ⚠ 排空遗留队列失败：${err.message}`);
        console.log('    排队的消息还在 ~/.baton/queue/ 下，下次启动会再试。\n');
      });

    stopWatch = watchQueues({
      repo,
      config,
      principalOf: auth.principalOf,
      log: (resumed) => {
        const sent = resumed.filter((r) => r.sent).length;
        if (sent) console.log(`  已发出     ${sent} 条排队的消息（电脑上那轮跑完了）`);
      },
    });
    if (!config.allowSend) {
      console.log(`  要在手机上发消息：在 ${path.join(BATON_DIR, 'config.json')} 里设 allowSend: true 后重启本进程。`);
      console.log('');
    }

    const missing = missingCredentials('claude');
    if (missing) {
      console.log(`  ⚠ 缺少环境变量 ${missing}：Claude 会话将无法发送消息（只读浏览不受影响）。`);
      console.log(`    ${CREDENTIAL_FIX}`);
      console.log('');
    }
  });
}

const parsed = parseCliArgs(process.argv.slice(2));
if (parsed.ok === false) {
  console.error(`\n  ${parsed.error}\n\n${parsed.fix}\n`);
  process.exit(1);
} else if (parsed.cmd === 'help') {
  console.log(USAGE);
} else if (parsed.cmd === 'version') {
  console.log(VERSION);
} else if (parsed.cmd === 'doctor') {
  const report = await runDoctor();
  if (parsed.json) console.log(JSON.stringify(report, null, 2));
  else printDoctorHuman(report);
  if (!report.ok) process.exit(1);
} else if (parsed.cmd === 'pair') {
  const code = await runPairCommand(parsed.for ? ['--for', parsed.for] : [], {
    host: parsed.host ?? null,
    port: parsed.port ?? null,
  });
  if (code !== 0) process.exit(code);
} else if (parsed.cmd === 'tunnel') {
  const cfg = loadConfig();
  const localHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? '127.0.0.1' : cfg.host;
  const target = formatHttpUrl(localHost, parsed.port ?? cfg.port);
  try {
    const t = await startQuickTunnel({ targetUrl: target });
    console.log(`\n  Quick Tunnel active: ${t.url} -> ${target}\n  Press Ctrl+C to stop.\n`);
    const stop = () => { t.stop(); process.exit(0); };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  } catch (err) {
    console.error(`\n  ${err.message}\n`);
    process.exit(1);
  }
} else {
  await runDaemon(parsed);
}
