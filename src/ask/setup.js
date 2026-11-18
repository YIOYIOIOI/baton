import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { BATON_DIR } from '../config.js';
import { mintAskToken, revokeAskToken } from './store.js';

/**
 * 每一轮写一份 MCP 配置，跑完就删。
 *
 * ## 为什么不用环境变量传令牌
 *
 * 最省事的写法是把令牌塞进 claude 的环境变量，让 MCP 服务器继承。但 MCP 的
 * 官方 SDK 在拉起 stdio 服务器时用的是 `getDefaultEnvironment()`——**那是一份
 * 白名单**，自定义变量会不会被滤掉没有文档保证。赌它等于把整条链挂在一个
 * 未经证实的行为上（CLAUDE.md：「拿不准就说拿不准，不要用推理填空」）。
 *
 * 配置文件里的 `env` 字段是 MCP 协议**明确规定**要传给子进程的，实测也确实
 * 到达了。所以每轮一个文件，令牌写在里面，0600，跑完删掉。
 *
 * ## 为什么不是一份共享配置
 *
 * 令牌是一次性的、绑这一轮的。共享文件就得在每轮之间改写同一个文件，
 * 而两轮之间有重叠窗口（前一轮的 claude 可能还没退干净），改写会把它的
 * 令牌换掉。一轮一个文件没有这个问题。
 */

const SERVER = url.fileURLToPath(new URL('./mcp.js', import.meta.url));

const askConfDir = (dir) => path.join(dir, 'ask');

/**
 * argv 里的路径。`runProcess` 用 `shell: true`（Windows 上 claude 是 .cmd 包装，
 * 必须经 shell），而 Node 的 DEP0190 明说**传给 shell 的参数不转义、只拼接**，
 * 于是带空格的路径会在空格处被切断。BATON_DIR 可由环境变量覆盖，不能假定没空格。
 */
export function shellPath(p) {
  const s = String(p ?? '');
  if (/[\r\n]/.test(s)) throw new Error('路径不能包含换行符。');
  if (/[\s&|<>^()%!;"'`$]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}

/**
 * 为这一轮准备提问通道。返回 null = 这一轮不开（调用方据此不加任何参数）。
 *
 * @param baseUrl MCP 服务器回连的地址。守护进程自己的监听地址，走回环。
 */
export function prepareAsk({ key, turnId, baseUrl, dir = BATON_DIR }) {
  if (!key || !turnId || !baseUrl) return null;
  const token = mintAskToken({ key, turnId });
  const file = path.join(askConfDir(dir), `${turnId}.json`);
  const conf = {
    mcpServers: {
      baton: {
        command: process.execPath,
        args: [SERVER],
        env: { BATON_ASK_URL: baseUrl, BATON_ASK_TOKEN: token },
      },
    },
  };
  try {
    fs.mkdirSync(askConfDir(dir), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(conf), { mode: 0o600 });
  } catch {
    // 写不进去就不开这一轮的提问通道。让一轮因为写不了临时文件而失败是不划算的
    revokeAskToken(token);
    return null;
  }
  return {
    token,
    configPath: file,
    cleanup() {
      revokeAskToken(token);
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // 留着也无害——启动时 reconcileAskConfigs 会清
      }
    },
  };
}

/**
 * 守护进程自己的回环地址。
 *
 * 监听在 0.0.0.0 时不能把它原样当回连地址（那不是一个可连的目标），
 * 统一走 127.0.0.1——MCP 服务器和守护进程必然在同一台机器上。
 */
export function loopbackUrl({ host, port }) {
  const h = !host || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${h.includes(':') ? `[${h}]` : h}:${port}`;
}

/** 启动时清掉上次跑剩的每轮配置。里面有已经作废的令牌，没有留着的理由。 */
export function reconcileAskConfigs({ dir = BATON_DIR } = {}) {
  let names;
  try {
    names = fs.readdirSync(askConfDir(dir));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    try {
      fs.rmSync(path.join(askConfDir(dir), name), { force: true });
      n += 1;
    } catch {
      // 删不掉就留着
    }
  }
  return n;
}
