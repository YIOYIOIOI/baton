import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { uploadToCwd } from '../src/http/handlers/files.js';
import { UPLOAD_DIR, MAX_BYTES } from '../src/upload.js';
import { tmpDir } from './helpers.js';

/**
 * 按 **cwd** 上传（而不是按会话 key）。
 *
 * ## 为什么需要它
 *
 * 新建会话那一屏要能带附件，而 `createSession` 是「建会话 + 跑第一轮」一次做完的，
 * 且 agent **只认磁盘路径**——附件路径必须出现在第一条消息里。于是顺序只能是
 * 「先传、再带着路径建会话」，可那时候还没有 session key 可用。
 *
 * ## 权限判据和「能不能在这个目录建会话」完全相同
 *
 * 绝对路径 ∧ 在调用者 roots 之下 ∧ 目录已存在 ∧ allowSend——逐条照抄
 * `createSession` 对 cwd 的那三条加写入闸。**所以它不多给任何权限**：能在某个
 * 目录起 agent 的人，本来就能让文件被写进那个目录（agent 自己就在那儿写）。
 *
 * 落盘那一层（safeName / realpath 包含性 / 同名不覆盖 / 大小上限）原样走
 * `saveUpload`，和按 key 那条是同一段代码，所以这里只测**授权**这一层，
 * 不重测已经被 upload.test.js 覆盖的东西。
 */

const OWNER = { id: 'owner', roots: null };
const GUEST = (root) => ({ id: 'friend', roots: [root] });
const OK = { allowSend: true };
const bytes = (s = 'hi') => Buffer.from(s);

test('owner 传到一个存在的目录：落到 .baton-uploads/ 并回相对路径', () => {
  const cwd = tmpDir();
  const r = uploadToCwd({ config: OK, principal: OWNER, cwd, name: 'a.txt', bytes: bytes('hello') });
  assert.equal(r.status, 201);
  assert.equal(r.body.relative, `${UPLOAD_DIR}/a.txt`);
  assert.equal(fs.readFileSync(path.join(cwd, UPLOAD_DIR, 'a.txt'), 'utf8'), 'hello');
});

test('只读模式下拒绝——和发消息、建会话同一条纪律', () => {
  const cwd = tmpDir();
  const r = uploadToCwd({ config: { allowSend: false }, principal: OWNER, cwd, name: 'a.txt', bytes: bytes() });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'send_disabled');
});

test('访客只能传进自己的 roots，别处一律 403', () => {
  const root = tmpDir();
  const inside = path.join(root, 'proj');
  fs.mkdirSync(inside);
  const outside = tmpDir();

  assert.equal(
    uploadToCwd({ config: OK, principal: GUEST(root), cwd: inside, name: 'a.txt', bytes: bytes() }).status,
    201,
    'roots 之下应当放行',
  );

  const bad = uploadToCwd({ config: OK, principal: GUEST(root), cwd: outside, name: 'a.txt', bytes: bytes() });
  assert.equal(bad.status, 403, 'roots 之外必须拒绝');
  assert.equal(bad.body.error.code, 'cwd_not_allowed');
  assert.ok(!fs.existsSync(path.join(outside, UPLOAD_DIR)), '被拒之后不该在那边留下任何目录');
});

test('前缀相同但不是子目录的兄弟目录，不算在 roots 之内', () => {
  // ws\friend 与 ws\friend-other：under() 里那个 + path.sep 就是为这个
  const base = tmpDir();
  const root = path.join(base, 'friend');
  const sibling = path.join(base, 'friend-other');
  fs.mkdirSync(root);
  fs.mkdirSync(sibling);
  const r = uploadToCwd({ config: OK, principal: GUEST(root), cwd: sibling, name: 'a.txt', bytes: bytes() });
  assert.equal(r.status, 403, 'friend-other 不在 friend 之下');
});

test('相对路径拒绝——判断归属之前必须先有一个确定的绝对路径', () => {
  const r = uploadToCwd({ config: OK, principal: OWNER, cwd: './somewhere', name: 'a.txt', bytes: bytes() });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'bad_cwd');
});

test('目录不存在：400，而且不替人把目录建出来', () => {
  const gone = path.join(tmpDir(), 'nope');
  const r = uploadToCwd({ config: OK, principal: OWNER, cwd: gone, name: 'a.txt', bytes: bytes() });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'cwd_not_found');
  assert.ok(!fs.existsSync(gone), '不存在的目录不该被这条请求创建出来');
});

test('cwd 是个文件而不是目录：400', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'f.txt');
  fs.writeFileSync(file, 'x');
  const r = uploadToCwd({ config: OK, principal: OWNER, cwd: file, name: 'a.txt', bytes: bytes() });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'cwd_not_found');
});

test('文件名里的目录穿越照样被压成叶子名（落盘那层和按 key 那条共用）', () => {
  const cwd = tmpDir();
  const r = uploadToCwd({
    config: OK, principal: OWNER, cwd, name: '../../escape.txt', bytes: bytes(),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.relative, `${UPLOAD_DIR}/escape.txt`);
  assert.ok(fs.existsSync(path.join(cwd, UPLOAD_DIR, 'escape.txt')));
});

test('空文件与超限：400，不写盘', () => {
  const cwd = tmpDir();
  assert.equal(
    uploadToCwd({ config: OK, principal: OWNER, cwd, name: 'a.txt', bytes: Buffer.alloc(0) }).status,
    400,
  );
  const big = uploadToCwd({
    config: OK, principal: OWNER, cwd, name: 'b.txt', bytes: Buffer.alloc(MAX_BYTES + 1),
  });
  assert.equal(big.status, 400);
  assert.ok(!fs.existsSync(path.join(cwd, UPLOAD_DIR, 'b.txt')));
});

test('同名不覆盖：第二个变成 -2', () => {
  const cwd = tmpDir();
  uploadToCwd({ config: OK, principal: OWNER, cwd, name: 'a.txt', bytes: bytes('one') });
  const r2 = uploadToCwd({ config: OK, principal: OWNER, cwd, name: 'a.txt', bytes: bytes('two') });
  assert.equal(r2.body.relative, `${UPLOAD_DIR}/a-2.txt`);
  assert.equal(fs.readFileSync(path.join(cwd, UPLOAD_DIR, 'a.txt'), 'utf8'), 'one', '第一个不该被覆盖');
});

/**
 * **已知边界，不是回归**：访客 root 下的一个 junction 能把落点带到外面。
 *
 * `inScope` 比的是 `path.resolve` 的结果（`src/scope.js`），不解析链接；而
 * `uploadTarget` 之后才对 cwd 取 realpath。于是「root/jump → 别处」这种链接
 * 通得过 cwd 校验，字节落在链接目标上。
 *
 * 这条**不是**这个端点引入的：`createSession` 用同一个 `inScope`，同一个
 * junction 会让 agent 直接起在那个目标目录里——后果比写一个文件大得多。
 * 所以它是工作区隔离的既有边界（设计文档 §9：「隔离管的是视图，不是 agent」，
 * owner 明确表示朋友可信、不做权限管控）。
 *
 * 这条测试钉的是**现状**，不是「这样是对的」。哪天要收紧，就在 `inScope` 那层
 * 两边都 realpath，然后把这条改成断言 403——那时候 createSession 也要一起改，
 * 而且每次会话列表过滤都会多出 realpath 的系统调用，是一笔要 owner 拍板的账。
 */
test('已知边界：root 下的 junction 会把落点带到工作区外（与 createSession 同源）', (t) => {
  if (process.platform !== 'win32') return t.skip('junction 是 Windows 的东西');

  const base = tmpDir();
  const root = path.join(base, 'root');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  const jump = path.join(root, 'jump');
  try {
    fs.symlinkSync(outside, jump, 'junction');
  } catch {
    return t.skip('这台机器建不了 junction');
  }

  const r = uploadToCwd({
    config: OK, principal: GUEST(root), cwd: jump, name: 'a.txt', bytes: bytes('escaped'),
  });
  assert.equal(r.status, 201, '现状是放行——改成 403 之前先读上面那段');
  assert.equal(
    fs.readFileSync(path.join(outside, UPLOAD_DIR, 'a.txt'), 'utf8'), 'escaped',
    '字节确实落在了链接目标上，而不是 root 里',
  );
  return undefined;
});
