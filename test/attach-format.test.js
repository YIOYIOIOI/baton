import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/**
 * 附件清单的格式是**两端之间的协议**，不是各自的实现细节。
 *
 * 发消息时附件路径以固定格式拼在正文末尾（agent 只认磁盘路径），而渲染时又要
 * 把那段拆掉换成缩略图——owner：「不要带上那个"附件：已放在"那个是给 agent
 * 看的不是给我看的」。
 *
 * app/ 与 web/ 是两个独立的包，没有共享模块的构建，所以这段逻辑各有一份。
 * **一旦漂移，从手机发的消息在电脑上就会把清单原样显示成正文**——2026-09-24
 * 之前就是这样，因为网页端压根没有这段逻辑。
 *
 * 这条测试同时读两个文件，比对那几处必须一模一样的东西。它不测行为
 * （两个包各自有单测），只钉「两边说的是同一种话」。
 */

const APP = read('app/src/store/attach.ts');
const WEB = read('web/src/attach.ts');
/**
 * 服务端**也**有一份。它本来不需要知道这个格式，直到发现会话**标题**是从第一条
 * 消息派生的——不切的话，侧栏和页头会显示成
 * 「只回复两个字：收到 附件（已放在工作目录下）： - .baton-uploads/…」。
 * 在服务端切，三端一次都对。
 */
const SRV = read('src/upload.js');

/** 取 `export const X = '…';` 的字面量。 */
function constOf(src, name) {
  const m = new RegExp(`export const ${name} = '([^']*)';`).exec(src);
  return m ? m[1] : null;
}

/** 取一个函数体（到下一个顶层 `}` 为止），用来比对拼接/解析的写法。 */
function bodyOf(src, name) {
  const at = src.indexOf(`export function ${name}(`);
  if (at < 0) return null;
  const end = src.indexOf('\n}', at);
  return end < 0 ? null : src.slice(at, end);
}

test('三处的附件清单抬头逐字一致', () => {
  const got = { app: constOf(APP, 'ATTACH_HEADING'), web: constOf(WEB, 'ATTACH_HEADING'), srv: constOf(SRV, 'ATTACH_HEADING') };
  for (const [k, v] of Object.entries(got)) assert.ok(v, `${k} 侧找不到 ATTACH_HEADING`);
  assert.equal(got.web, got.app, `抬头漂移：app=${got.app} web=${got.web}`);
  assert.equal(got.srv, got.app, `抬头漂移：app=${got.app} srv=${got.srv}`);
  // 顺带钉住它本身——改这个字符串等于让所有历史消息的清单认不出来
  assert.equal(got.app, '附件（已放在工作目录下）：');
});

/**
 * 只发文件、一个字没写的消息，清单前面**没有**那两个前导换行
 * （发送方 `suffix.trimStart()` 去掉了）。只认 `\n\n抬头\n` 的话，
 * 纯附件消息的清单会原样显示给人看——而「第一条消息可以只是几个文件」
 * 正是 2026-09-24 刚加的能力。三处都要认这两种形状。
 */
test('三处都认「抬头在开头」这种形状（只发文件、没写字）', () => {
  for (const [label, src, fn] of [
    ['app', APP, 'splitAttachments'],
    ['web', WEB, 'splitAttachments'],
    ['srv', SRV, 'stripAttachmentList'],
  ]) {
    const b = bodyOf(src, fn);
    assert.ok(b, `${label} 侧找不到 ${fn}`);
    assert.match(b, /startsWith\(head\)/, `${label} 没有认「抬头在开头」那种形状`);
  }
});

test('两端拼清单的写法一致（同一个模板、同一种括号）', () => {
  for (const [label, src] of [['app', APP], ['web', WEB]]) {
    const b = bodyOf(src, 'attachmentSuffix');
    assert.ok(b, `${label} 侧找不到 attachmentSuffix`);
    assert.match(b, /- \$\{a\.relative\}（\$\{fmtBytes\(a\.bytes\)\}）/, `${label} 的每行格式不对`);
    assert.match(b, /\\n\\n\$\{ATTACH_HEADING\}\\n/, `${label} 的分隔不对`);
  }
});

test('两端解析清单的正则一致，且都允许文件名里有空格', () => {
  const re = /const m = \/\^-\\s\+\((.+?)\)（\[\^）\]\*）\$\/\.exec/;
  const got = [];
  for (const [label, src] of [['app', APP], ['web', WEB]]) {
    const b = bodyOf(src, 'splitAttachments');
    assert.ok(b, `${label} 侧找不到 splitAttachments`);
    const m = re.exec(b);
    assert.ok(m, `${label} 的解析正则不是约定的那个形状`);
    got.push(m[1]);
  }
  assert.equal(got[0], got[1], `两端路径捕获组不一致：${got.join(' vs ')}`);
  // 服务端 safeName 不删空格，所以 `\S+` 会让带空格的文件名整段解析失败
  assert.equal(got[0], '.+?', '路径捕获组必须允许空格（safeName 不删空格）');
});
