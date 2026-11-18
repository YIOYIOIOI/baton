import { runProcess } from './spawn.js';
import { stripAttachmentList } from '../upload.js';

/**
 * 给手机上新建的会话起个名字——**和 Claude App 做的是同一件事**。
 *
 * owner 2026-10-08：「用 claude 原生新建对话不就可以做到和 claude 一样的让他
 * 自己去取标题了吗」。Baton 新建会话走的本来就是原生 CLI（`claude -p --session-id`），
 * 差的不是「原不原生」，是 App 在 CLI 之外**另外问了一次模型**：App 在一轮结束后
 * 调 `generateSessionTitle`，把结果写进注册项，再同步回 CLI。
 *
 * 实测（claude 2.1.281，见 docs/ops/agent-protocol.md §10）：
 *
 *   `claude -p` 自己不起名   sdk-cli 的 transcript 里 ai-title / agent-name 都没有；
 *                            交互式 CLI 和桌面 App 的会话才有
 *   起一次名 6–11 秒         所以它不能挡在新建这条路上——新建那一屏等的是第一轮
 *   `--name` 能写进 transcript   但只能在启动时给，而那时还没有标题
 *
 * 于是：**并着第一轮一起跑**，拿到了就改注册项的标题（见 handlers/create.js）。
 * 失败、超时、回了一段不像标题的话——一律当没有，会话照样建好，标题退回首句。
 */

/** 便宜、够用。起名是一句话的活，不值得用主力模型。 */
export const TITLE_MODEL = 'claude-haiku-4-5-20251001';

/** 标题上限。注册项里存得下更长的，但再长就不是标题了。 */
const MAX = 40;

/** 别让它跑太久：后台的锦上添花，拖着不退只是占着一个进程。 */
const TIMEOUT_MS = 60_000;

const PROMPT = [
  '给下面这条消息起一个会话标题。只输出标题本身，不要引号、不要句号、不要解释，只能一行。',
  '中文不超过 12 个字；原文是英文就用英文，不超过 6 个词。',
  '',
  '消息：',
].join('\n');

/** @returns {string[]} */
export function buildTitleArgs() {
  return [
    '-p',
    '--model', TITLE_MODEL,
    // 不留 transcript：这不是一条会话，不该出现在 App 侧栏、也不该进 Baton 列表
    '--no-session-persistence',
  ];
}

/**
 * 把模型回的那行收拾成标题，**收拾不动就返回 null**。
 *
 * 宁可退回首句也不要一句奇怪的话：首句至少是用户自己写的。
 *
 * @param {string | null | undefined} raw
 * @returns {string | null}
 */
export function cleanTitle(raw) {
  const text = String(raw ?? '').trim();
  if (!text || text.includes('\n')) return null;
  const stripped = text
    .replace(/^(标题|title)\s*[:：]\s*/i, '')
    .replace(/^["'“”「『]+|["'“”」』.。]+$/g, '')
    .trim();
  if (!stripped || stripped.length > MAX) return null;
  // CLI 把自己的毛病也打在 stdout 上（`Not logged in · Please run /login`）
  if (/^not logged in|^error\b|please run \//i.test(stripped)) return null;
  return stripped;
}

/**
 * @param {{ message: string, cwd?: string, env?: NodeJS.ProcessEnv, command?: string,
 *   run?: typeof runProcess, timeoutMs?: number }} opts
 * @returns {Promise<string | null>}
 */
export async function generateTitle({
  message, cwd, env = process.env, command = 'claude', run = runProcess, timeoutMs = TIMEOUT_MS,
}) {
  // 末尾那段附件清单是写给 agent 的路径，不是这条会话在说什么。切掉之后一个字
  // 都不剩（只传了文件）时根本不调：文件名本身就是标题，没有可总结的正文。
  const { body } = stripAttachmentList(String(message ?? ''));
  const text = body.trim();
  if (!text) return null;

  let res;
  try {
    res = await run({
      command,
      args: buildTitleArgs(),
      cwd,
      env,
      // 提示词和原文一起走 stdin：原文一个字都不进 argv（和发消息同一条规矩）
      message: `${PROMPT}\n${text}\n`,
      timeoutMs,
    });
  } catch {
    return null; // 起不来就是没有标题
  }
  if (res?.code !== 0) return null;
  const lines = (res.lines ?? []).filter((l) => String(l).trim());
  if (lines.length !== 1) return null;
  return cleanTitle(lines[0]);
}
