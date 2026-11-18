/**
 * `npm run pair` 的参数解析。
 *
 * ## 为什么这一小段要单独拿出来、还要有测试
 *
 * 2026-09-20：owner 想给朋友取一个访客码，朋友兑换后看到的是 owner 的全部工作区。
 * 隔离逻辑（scope.js）是对的，错在取码这一步：
 *
 *     npm run pair --for friend      ← 只有一个 --
 *
 * npm 把 `--for` 当成自己的配置吃掉了，脚本收到的 argv 是 `["friend"]`。老代码
 * 用 `argv.indexOf('--for')` 找不到标志，就**静默退回给 owner 铸码**——身份 id
 * 明明就躺在 argv 里，却被丢掉了。
 *
 * 这条路在安全边界上是 fail-open 的：**敲错一个标志 = 把全部工作区交出去**。
 * 而且代价不对称——猜错成 owner 是灾难，猜错成访客只是少看见几条会话。
 *
 * 所以规则是：**看不懂就拒绝**。放行只有两种情况——什么都不带（owner 自己的
 * 设备），或者规规矩矩的 `--for <id>`。裸 id、写错的标志名、多余的参数，一律
 * 停下来问人，绝不替他决定。
 */

// 和 principals.js 的 ID_RE 保持一致：那边合法这边才合法，免得报两种错
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const NEAR_MISS = ['--guest', '--as', '--user', '--principal', '--to', '-f'];

/**
 * @param {string[]} args  process.argv.slice(2)
 * @returns {{ok: true, for: string|null} | {ok: false, error: string, fix: string}}
 *   `for: null` = 给 owner 自己铸。
 */
export function parsePairArgs(args) {
  const raw = Array.isArray(args) ? args.map(String) : [];
  /** @type {(error: string, fix: string) => { ok: false, error: string, fix: string }} */
  const no = (error, fix) => ({ ok: false, error, fix });

  /*
    npm 只吃掉**第一个** `--`，多写的会原样传进来。`--` 本来就是「后面的别当
    选项解析」的老约定，多一个不该算错，所以先把它们滤掉再看剩下什么。
  */
  const argv = raw.filter((a) => a !== '--');
  if (argv.length === 0) return { ok: true, for: null };

  /*
    `npm run pair -- -- for friend` —— 两个 --，而且 `--for` 被空格拆成了两半。
    owner 2026-09-20 第二次就是这么敲的，于是又铸了一个 owner 的码发出去。
    这一条必须排在「全是裸词」前面：滤掉 -- 之后它看着也像一串裸词，
    但真正的毛病是那个空格，报错得说中它。
  */
  if (argv[0] === 'for') {
    const guess = argv[1] ?? '<身份 id>';
    return no(
      '--for 被空格拆成了两半。',
      `--for 是一个词，中间不能有空格：npm run pair -- --for ${guess}`,
    );
  }

  // 「npm 把标志吃掉了」：剩下的全是裸词，而第一个看起来就是个 id。
  // 报错必须指着那个少写的 -- 说话，否则人会照原样再敲一遍。
  if (!argv.some((a) => a.startsWith('-'))) {
    const guess = argv[0];
    return no(
      `不明白这个参数：${argv.join(' ')}`,
      `你大概是想给 "${guess}" 取码，但 npm 把 --for 吃掉了：`
      + `要写**两个** --，即 npm run pair -- --for ${guess}`
      + '（第一个 -- 是告诉 npm「后面的别动，原样传给脚本」）。',
    );
  }

  for (const wrong of NEAR_MISS) {
    if (argv.includes(wrong) || argv.some((a) => a.startsWith(`${wrong}=`))) {
      const guess = argv[argv.indexOf(wrong) + 1] ?? '<身份 id>';
      return no(
        `没有 ${wrong} 这个选项。`,
        `指定身份用 --for，例如：npm run pair -- --for ${guess}`,
      );
    }
  }

  let want = null;
  let seen = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--for') {
      if (seen) return no('--for 只能出现一次。', '一个码只属于一个身份。');
      seen = true;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        return no('--for 后面要跟一个身份 id。', '例如：npm run pair -- --for friend');
      }
      want = next;
      i += 1;
    } else if (a.startsWith('--for=')) {
      if (seen) return no('--for 只能出现一次。', '一个码只属于一个身份。');
      seen = true;
      want = a.slice('--for='.length);
      if (!want) return no('--for= 后面是空的。', '例如：npm run pair -- --for friend');
    } else {
      return no(
        `不明白这个参数：${a}`,
        '只认 --for <身份 id>。不带任何参数就是给你自己这台设备取码。',
      );
    }
  }

  if (!ID_RE.test(want)) {
    return no(
      `身份 id 不合法：${JSON.stringify(want)}`,
      '只允许小写字母、数字、下划线、短横线，首字符为字母或数字，最长 32——'
      + '和 ~/.baton/principals.json 里那个 id 一模一样地写。',
    );
  }
  return { ok: true, for: want };
}
