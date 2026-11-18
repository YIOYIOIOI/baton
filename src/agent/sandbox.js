import { runBuffered } from './spawn.js';

/**
 * 这台电脑上 Codex 的沙箱装好了没有。
 *
 * ## 为什么需要问这件事
 *
 * 实测（2026-09-15，判据是磁盘副作用不是 agent 的说辞）：
 *
 *   codex exec 不加参数                 失败  setup helper: 1223
 *   codex exec --sandbox read-only      失败  同上
 *   codex exec --sandbox workspace-write **挂住**，150 秒没有任何回应
 *   codex exec --dangerously-bypass-... 成功
 *
 * `codex doctor` 给了根因：**elevated Windows sandbox provisioning is incomplete
 * or outdated**。1223 是 ERROR_CANCELLED——它去 ShellExecuteExW 拉一个要提权的
 * setup helper，而守护进程里没有人能点那个 UAC 弹窗。
 *
 * 挂住比失败糟得多：手机上点了「只能写工作区」，然后这一轮再也不会回来。
 * 所以要在**放出选项之前**就知道答案，把用不了的档位禁掉并写明原因，
 * 而不是让人点下去等。
 *
 * ## 为什么解析 doctor 的文字而不是试跑一次
 *
 * 试跑就是那个会挂住 150 秒的操作本身。doctor 是只读诊断，当时几秒返回
 *（0.164 起要 100 秒，所以改成后台问、不挡请求，见 FIRST_WAIT_MS）。
 *
 * 代价说清楚：**这是在解析人看的输出**，措辞变了会失灵。所以只匹配两个词
 * （`sandbox` 那一行里有没有 `incomplete` 或 `outdated`），并且**匹配不上时
 * 返回 unknown 而不是 ready**——拿不准的时候按「可能用不了」处理，
 * 界面上给提示但不禁用，让人自己决定要不要试。
 */

/**
 * 诊断结果的缓存时长。沙箱预置是装一次的事，不会在一轮对话里变。
 * 30 分钟：doctor 现在一跑 100 秒、还要连网，不值得每 5 分钟跑一遍。
 */
const TTL_MS = 30 * 60 * 1000;

/**
 * doctor 最多跑多久。2026-11-10 实测 codex 0.164 的 doctor 要 **100 秒**（原来几秒），
 * 原先的 20 秒上限于是次次超时，答案永远是 unknown。现在它在后台跑、不挡任何请求，
 * 上限放宽到 3 分钟。
 */
const TIMEOUT_MS = 180_000;

/**
 * 头一回问、手上还没有任何答案时，最多等这么久；等不到先答 unknown，后台跑完自己填上。
 *
 * 原来是**每次缓存过期都同步等 doctor**：打开会话配置，「权限档位」那一组卡在
 * 「正在读…」20 秒（2026-11-10 在线上 3002 量到的：/api/permission 20 秒不回）。
 */
const FIRST_WAIT_MS = 1500;

/** @type {{ at: number, state: string } | null} */
let cache = null;
/** @type {Promise<string> | null} 正在跑的那一次 doctor——同一时间只跑一个 */
let inflight = null;

/** `unknown` 不是「坏」也不是「好」——它表示这台机器上没问出来。 */
export function parseDoctor(text) {
  const lines = String(text ?? '').split('\n');
  /*
    两代格式：
      0.157 前后  ⚠ sandbox      elevated Windows sandbox provisioning is incomplete or outdated
      0.164       ✓ sandbox      unrestricted fs + enabled network · approval Never
                      …
                      sandbox backend          elevated
                      …
                      sandbox provisioning     complete
    0.164 那段里 `sandbox backend  elevated` 排在前面。原来的判据是「同一行有 sandbox 又有
    provisioning|elevated」，抓到的是 backend 那行——它永远不含 incomplete，于是沙箱真没装好
    也会答 ready。所以**先找写着 provisioning 的那行**，只认它。
  */
  const line = lines.find((l) => /\bsandbox\s+provisioning\b/i.test(l))
    ?? lines.find((l) => /\bsandbox\b/i.test(l) && /provisioning/i.test(l));
  if (!line) return 'unknown';
  // incomplete 里含 complete，所以先判缺
  return /incomplete|outdated|missing|not\s+complete/i.test(line) ? 'missing' : 'ready';
}

/**
 * 跑一次 `codex doctor` 问沙箱状态。返回 'ready' | 'missing' | 'unknown'。
 *
 * 任何异常（没装 codex、超时、非零退出）都落到 'unknown'——这个函数的职责是
 * 提供一条建议，不是成为一个新的故障点。
 */
export async function codexSandboxState({ now = Date.now(), run = defaultRun, waitMs = FIRST_WAIT_MS } = {}) {
  if (cache && now - cache.at < TTL_MS) return cache.state;
  const already = inflight !== null;
  const fresh = refresh(run, now);
  // 有旧答案就先拿旧的顶着：沙箱装没装好不会在半小时里来回变，后台刷新完下次就是新的
  if (cache) return cache.state;
  // 已经有一次在跑（启动时预热的，或前一个请求起的）：它要跑 100 秒，再等 1.5 秒也白等
  if (already) return 'unknown';
  return Promise.race([
    fresh,
    new Promise((r) => { setTimeout(() => r('unknown'), waitMs).unref?.(); }),
  ]);
}

/**
 * 起一次 doctor（已经在跑就搭它的车），跑完写缓存。
 * @param {() => Promise<string>} run
 * @param {number} now
 * @returns {Promise<string>}
 */
function refresh(run, now) {
  inflight ??= (async () => {
    let state = 'unknown';
    try {
      state = parseDoctor(await run());
    } catch {
      state = 'unknown';
    }
    cache = { at: now, state };
    return state;
  })().finally(() => { inflight = null; });
  return inflight;
}

/** 测试用：清掉缓存与在跑的那一次。 */
export function clearSandboxCache() {
  cache = null;
  inflight = null;
}

function defaultRun() {
  if (process.env.BATON_NO_CLI_PROBES === '1') {
    return Promise.reject(new Error('probes disabled'));
  }
  return runBuffered('codex', ['doctor'], {
    timeoutMs: TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    unref: true,
  }).then(({ code, stdout, stderr }) => {
    // doctor 有警告时退出码非零，但输出照样是我们要的——所以不看退出码，只看有没有输出
    const text = `${stdout}\n${stderr}`;
    if (text.trim()) return text;
    throw new Error(`codex doctor 没有输出（exit ${code}）`);
  });
}

