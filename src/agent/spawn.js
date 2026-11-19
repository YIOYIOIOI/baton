import { spawn } from 'node:child_process';
import { cliLaunch } from './codexRuntime.js';

/** 结束子进程及整个进程树：shell:true 下 child.kill() 只杀那层 cmd.exe。 */
export function killChildTree(child) {
  if (!child) return;
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    try {
      child.kill?.();
    } catch {
      // 已经退了
    }
    return;
  }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true })
      .on('error', () => child.kill?.());
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill?.();
      } catch {
        // 已经退了
      }
    }
  }
}

function unrefStream(s) {
  if (s && 'unref' in s && typeof s.unref === 'function') s.unref();
}

/** 运行短命只读 CLI 并收集完整输出：带缓冲区上限与超时树杀。 */
export async function runBuffered(command, args, {
  timeoutMs = 30_000, maxBuffer = 4 * 1024 * 1024, unref = false, runtime = null,
} = {}) {
  const launch = runtime ?? await cliLaunch(command);
  return new Promise((resolve, reject) => {
    const child = spawn(launch.command, args, {
      shell: launch.shell, env: launch.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });
    if (unref) {
      child.unref?.();
      unrefStream(child.stdout);
      unrefStream(child.stderr);
    }

    const out = [];
    const errChunks = [];
    let total = 0;
    let settled = false;
    const finish = (err, res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(res);
    };
    const append = (list) => (d) => {
      total += d.length;
      if (total > maxBuffer) {
        killChildTree(child);
        finish(new Error(`${command} 输出超过上限`));
        return;
      }
      list.push(d);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      finish(new Error(`${command} 超时`));
    }, timeoutMs);
    if (unref) timer.unref?.();

    child.stdout?.on('data', append(out));
    child.stderr?.on('data', append(errChunks));
    child.on('error', (e) => finish(e));
    child.on('close', (code) => {
      finish(null, {
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
  });
}

/**
 * @param {{ command: string, args: string[], cwd?: string, message?: string,
 *   onLine?: (line: string) => void, onStart?: (h: { kill: () => void }) => void,
 *   timeoutMs?: number | null, maxStderrBytes?: number, maxRetainedBytes?: number, env?: NodeJS.ProcessEnv }} opts
 */
export async function runProcess({
  command, args, cwd, message, onLine, onStart, timeoutMs = null,
  maxStderrBytes = 512 * 1024, maxRetainedBytes = 8 * 1024 * 1024, env = process.env,
}) {
  let child;
  let killed = false;
  onStart?.({ kill() { killed = true; killChildTree(child); } });
  const launch = await cliLaunch(command, env, true);
  if (killed) return { code: null, lines: [], stderr: '', timedOut: false, killed };
  return new Promise((resolve) => {
    child = spawn(launch.command, args, {
      cwd,
      env: launch.env,
      shell: launch.shell,
      windowsHide: true,
      ...(process.platform !== 'win32' ? { detached: true } : {}),
    });

    const headBudget = Math.max(256, Math.floor(maxRetainedBytes / 4));
    const headLines = [];
    let headBytes = 0;
    const tailLines = [];
    let tailBytes = 0;
    const retainLine = (line) => {
      if (headLines.length < 32 && headBytes + line.length <= headBudget) {
        headLines.push(line);
        headBytes += line.length;
        return;
      }
      const entry = line.length > maxRetainedBytes ? line.slice(-maxRetainedBytes) : line;
      tailLines.push(entry);
      tailBytes += entry.length;
      while (tailLines.length > 1 && headBytes + tailBytes > maxRetainedBytes) {
        tailBytes -= tailLines.shift().length;
      }
    };
    const emitLine = (line) => {
      retainLine(line);
      onLine?.(line);
    };

    let buf = '';
    let stderr = '';
    let timedOut = false;

    // shell:true 下 child 是 cmd.exe，child.kill() 只杀那一层，真正的 agent
    // 照跑到底：stdout 管道不关 → promise 永不 resolve → 轮次永远挂在 running。
    // 实测踩过两次——外部停止回报 stopped:true 却什么都没停下；timeoutMs
    // 也形同虚设（30 秒超时对一个活 60 秒的进程毫无作用）。必须杀整棵树。
    const killTree = () => killChildTree(child);

    // 整轮时长**默认不设上限**（2026-10-01 起）。
    //
    // 原来默认 600 秒，一到就杀整棵树，会把长任务在正常执行中途杀掉；
    // 改由用户点停止收尾——stopTurn 走的也是 killTree，整棵树一起杀。
    // 显式传 timeoutMs 仍然有效（测试在用）。
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs)
      : null;
    timer?.unref?.();

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024 * 1024) {
        buf = buf.slice(-8 * 1024 * 1024);
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        emitLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      if (stderr.length >= maxStderrBytes) return;
      const room = maxStderrBytes - stderr.length;
      stderr += c.length > room ? `${c.slice(0, room)}\n...[stderr truncated]` : c;
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, lines: [...headLines, ...tailLines], stderr: `${stderr}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) emitLine(buf.trim());
      resolve({ code, lines: [...headLines, ...tailLines], stderr, timedOut, killed });
    });

    // 对方没读完就退了（命令不存在、凭据不对当场退出），写 stdin 会报 EPIPE——
    // Windows 上报的是 `write EOF`。没人接这个 error 事件，它就会把守护进程带走
    // （2026-10-01 审查）。记进 stderr，这一轮照常以进程的退出码收尾。
    child.stdin.on('error', (err) => { stderr += `\n写 stdin 失败：${err.message}`; });
    // 显式 UTF-8 写入，不经 shell 代码页——实测中文往返完好
    child.stdin.end(message ?? '', 'utf8');
  });
}
