import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safeName, uploadTarget, uniquePath, saveUpload, readUpload, UPLOAD_DIR } from '../src/upload.js';
import { uploadFile, downloadUpload } from '../src/http/handlers/files.js';
import { tmpDir } from './helpers.js';

const tmp = (p) => tmpDir(p);

// ── 文件名 ──────────────────────────────────────

test('文件名：目录穿越的各种写法一律压成叶子名', () => {
  const cases = [
    ['../../../etc/passwd', 'passwd'],
    ['..\\..\\Windows\\System32\\cmd.exe', 'cmd.exe'],
    ['/etc/shadow', 'shadow'],
    ['C:\\Users\\alice\\.ssh\\id_rsa', 'id_rsa'],
    ['a/b/c/note.md', 'note.md'],
  ];
  for (const [input, want] of cases) {
    assert.equal(safeName(input), want, `${input} 该被压成 ${want}`);
  }
});

test('文件名：前导点去掉——.bashrc 落进项目目录是有后果的', () => {
  assert.equal(safeName('.bashrc'), 'bashrc');
  assert.equal(safeName('...hidden'), 'hidden');
  assert.equal(safeName('..'), null);
});

test('文件名：NUL 截断与控制字符', () => {
  assert.equal(safeName('safe.txt\u0000.exe'), 'safe.txt.exe');
  assert.equal(safeName('a\u0001b\u001fc.txt'), 'abc.txt');
});

test('文件名：Windows 保留字符与设备名', () => {
  assert.equal(safeName('a<b>c:d"e|f?g*h.txt'), 'abcdefgh.txt');
  assert.equal(safeName('CON'), '_CON');
  assert.equal(safeName('nul.txt'), '_nul.txt');
  // 结尾的点/空格在 Windows 上创建时会被悄悄吃掉，名字就对不上了
  assert.equal(safeName('report.txt.  '), 'report.txt');
});

test('文件名：全是非法字符时返回 null，而不是返回空串继续往下走', () => {
  for (const v of ['', '   ', '...', '<<>>', null, undefined]) {
    assert.equal(safeName(v), null, `${JSON.stringify(v)} 该是 null`);
  }
});

test('文件名：过长时截断但保住扩展名', () => {
  const n = safeName(`${'x'.repeat(300)}.md`);
  assert.ok(n.length <= 100, `实际 ${n.length}`);
  assert.ok(n.endsWith('.md'), '扩展名不能丢——丢了就认不出是什么文件');
});

// ── 落盘位置 ────────────────────────────────────

test('uploadTarget：目标必须落在 cwd/.baton-uploads 里', () => {
  const cwd = tmp('baton-up-');
  const t = uploadTarget(cwd, 'note.md');
  assert.equal(path.basename(t.dir), UPLOAD_DIR);
  assert.equal(t.relative, `${UPLOAD_DIR}/note.md`);
  assert.ok(t.full.startsWith(fs.realpathSync(cwd) + path.sep));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uploadTarget：穿越写法进来也只会落在上传目录里', () => {
  const cwd = tmp('baton-up2-');
  const real = fs.realpathSync(cwd);
  for (const bad of ['../../evil.txt', '..\\..\\evil.txt', '/etc/evil.txt']) {
    const t = uploadTarget(cwd, bad);
    assert.equal(path.dirname(t.full), path.join(real, UPLOAD_DIR), `${bad} 逃出去了`);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uploadTarget：.baton-uploads 是指向外面的链接时必须拒绝', (t) => {
  // 这一条是照着已经犯过的那个错写的：当时静态资源那道闸用 path.resolve，
  // 注释里写着防符号链接，实际一个 junction 就穿过去了。
  const cwd = tmp('baton-link-');
  const outside = tmp('baton-outside-');
  const linkPath = path.join(cwd, UPLOAD_DIR);
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, outside], { stdio: 'ignore' });
    } else {
      fs.symlinkSync(outside, linkPath, 'dir');
    }
  } catch {
    t.skip('这台机器上建不了目录链接（需要权限）');
    return;
  }
  assert.throws(() => uploadTarget(cwd, 'x.txt'), /工作目录之外/);
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('上传目录自己忽略自己——传上来的文件不该跟着 git add . 进仓库', () => {
  const cwd = tmp('baton-ign-');
  const t = uploadTarget(cwd, 'a.txt');
  const ig = path.join(t.dir, '.gitignore');
  assert.ok(fs.existsSync(ig), '该写一个 .gitignore 进去');
  assert.match(fs.readFileSync(ig, 'utf8'), /^\*$/m, '要忽略目录下所有文件');

  // 用户改过就不要覆盖——那是他的决定
  fs.writeFileSync(ig, '# 我自己写的\n');
  uploadTarget(cwd, 'b.txt');
  assert.equal(fs.readFileSync(ig, 'utf8'), '# 我自己写的\n', '不该盖掉用户改过的内容');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uploadTarget：cwd 不存在时抛，而不是在别处建一个', () => {
  assert.throws(() => uploadTarget(path.join(os.tmpdir(), 'baton-no-such-dir-xyz'), 'a.txt'));
  assert.throws(() => uploadTarget(null, 'a.txt'), /工作目录/);
});

test('uniquePath：同名不覆盖', () => {
  // 用 path.join 造集合：uniquePath 内部也用 path.join，分隔符必须一致，
  // 否则这个 fake 永远命中不了，测试看着绿其实什么都没测
  const j = (n) => path.join(os.tmpdir(), 'd', n);
  const seen = new Set([j('a.txt'), j('a-2.txt')]);
  const exists = (p) => seen.has(p);
  assert.equal(uniquePath(j('b.txt'), { exists }), j('b.txt'));
  assert.equal(uniquePath(j('a.txt'), { exists }), j('a-3.txt'));
});

// ── 存 ──────────────────────────────────────────

test('saveUpload：写进去、读得回、同名不覆盖', () => {
  const cwd = tmp('baton-save-');
  const a = saveUpload({ cwd, name: 'note.md', bytes: Buffer.from('hello') });
  assert.equal(a.name, 'note.md');
  assert.equal(a.bytes, 5);
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'hello');

  const b = saveUpload({ cwd, name: 'note.md', bytes: Buffer.from('world') });
  assert.equal(b.name, 'note-2.md', '同名该另存，不该盖掉十分钟前传的那个');
  assert.equal(fs.readFileSync(a.path, 'utf8'), 'hello', '第一个文件必须原封不动');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('saveUpload：空文件与超大文件都拒绝', () => {
  const cwd = tmp('baton-size-');
  assert.throws(() => saveUpload({ cwd, name: 'a.txt', bytes: Buffer.alloc(0) }), /空/);
  assert.throws(
    () => saveUpload({ cwd, name: 'a.txt', bytes: Buffer.alloc(21 * 1024 * 1024) }),
    /过大/,
  );
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ── handler ─────────────────────────────────────

const repoWith = (member) => ({ getSession: (k) => (k === 'K' ? member : null) });

test('uploadFile：allowSend 关着时拒绝——它往 owner 磁盘上写东西', () => {
  const r = uploadFile({
    repo: repoWith({ cwd: 'C:/x' }), config: { allowSend: false },
    key: 'K', name: 'a.txt', bytes: Buffer.from('x'),
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'send_disabled');
});

test('uploadFile：会话不存在 404，没有 cwd 400', () => {
  const cfg = { allowSend: true };
  assert.equal(uploadFile({ repo: repoWith({ cwd: 'C:/x' }), config: cfg, key: '??', bytes: Buffer.from('x') }).status, 404);
  const r = uploadFile({ repo: repoWith({ cwd: null }), config: cfg, key: 'K', name: 'a.txt', bytes: Buffer.from('x') });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, 'no_cwd');
});

test('uploadFile：成功时返回可直接贴进消息的相对路径', () => {
  const cwd = tmp('baton-h-');
  const r = uploadFile({
    repo: repoWith({ cwd }), config: { allowSend: true },
    key: 'K', name: 'spec.md', bytes: Buffer.from('# hi'),
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.relative, `${UPLOAD_DIR}/spec.md`);
  assert.match(r.body.note, /在消息里写上这个路径/);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uploadFile：底层抛什么错，就把什么错原样告诉用户', () => {
  const r = uploadFile({
    repo: repoWith({ cwd: 'C:/x' }), config: { allowSend: true },
    key: 'K', name: 'a.txt', bytes: Buffer.from('x'),
    save: () => { throw new Error('磁盘满了'); },
  });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.message, '磁盘满了');
  assert.match(r.body.error.fix, /20 MB/);
});

/**
 * 读取端点是**新增的读取面**，所以它的边界要单独钉住。
 *
 * 核心性质只有一条：**它能读到的，恰好等于它自己写出去过的**。这不是靠 handler
 * 里再写一遍检查换来的，而是靠复用 `uploadTarget()`——写入时那套同样的
 * safeName + realpath 包含性校验。下面几条就是在证明那条复用确实挡住了。
 */
test('readUpload：只认文件名，穿不出上传目录', () => {
  const cwd = tmp('baton-r-');
  saveUpload({ cwd, name: 'ok.txt', bytes: Buffer.from('yes') });
  // 同目录里放一个"机密"，再试各种方式去够它
  fs.writeFileSync(path.join(cwd, 'secret.txt'), 'no');

  assert.equal(readUpload({ cwd, name: 'ok.txt' }).bytes.toString(), 'yes');

  // 反斜杠那条原来写成了 '..\secret.txt'：`\s` 不是转义，字符串实际是「..secret.txt」，
  // Windows 的反斜杠穿越从来没被测到过（2026-10-01 上 lint 时发现）。
  for (const attack of ['../secret.txt', '..\\secret.txt', 'a\\..\\..\\secret.txt', '/etc/passwd', 'a/../../secret.txt']) {
    assert.throws(() => readUpload({ cwd, name: attack }), undefined, `${attack} 不该读到`);
  }
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('downloadUpload：读不到就一律 404，不讲目录结构', () => {
  const cwd = tmp('baton-r2-');
  const res = { writeHead() { throw new Error('不该走到这儿'); }, end() {} };
  const r = downloadUpload({ repo: repoWith({ cwd }), key: 'K', name: '不存在.png', res });
  assert.equal(r.status, 404);
  assert.equal(r.body.error.code, 'no_such_upload');
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('downloadUpload：命中时把原始字节交给 res，并返回 null 表示已接管', () => {
  const cwd = tmp('baton-r3-');
  saveUpload({ cwd, name: 'pic.png', bytes: Buffer.from([1, 2, 3]) });
  let head = null; let sent = null;
  const res = { writeHead: (s, h) => { head = { s, h }; }, end: (b) => { sent = b; } };
  const r = downloadUpload({ repo: repoWith({ cwd }), key: 'K', name: 'pic.png', res });
  assert.equal(r, null);
  assert.equal(head.s, 200);
  assert.match(head.h['Content-Type'], /image\/png/);
  assert.deepEqual([...sent], [1, 2, 3]);
  fs.rmSync(cwd, { recursive: true, force: true });
});

// ── 读回去的文件不能在我们的源上执行脚本（2026-10-01 审查）──────────────

function served(name, bytes = Buffer.from('<script>alert(1)</script>')) {
  const cwd = tmp('baton-xss-');
  saveUpload({ cwd, name, bytes });
  let head = null;
  const res = { writeHead: (s, h) => { head = h; }, end() {} };
  downloadUpload({ repo: repoWith({ cwd }), key: 'K', name, res });
  fs.rmSync(cwd, { recursive: true, force: true });
  return head;
}

test('downloadUpload：能跑脚本的类型一律当下载，不在页面里打开', () => {
  // 原来 .html 按扩展名给 text/html、直接渲染：访客传一个上来、诱你点开，
  // 脚本就带着你的 cookie 跑，能替他铸一个 owner 的配对码
  for (const name of ['evil.html', 'evil.svg', 'evil.xml', 'evil.js', 'note.pdf']) {
    const h = served(name);
    assert.match(h['Content-Disposition'] ?? '', /^attachment/, `${name} 必须是下载`);
  }
});

test('downloadUpload：一律带 nosniff 和 CSP sandbox，图片也不例外', () => {
  for (const name of ['pic.png', 'evil.html']) {
    const h = served(name);
    assert.equal(h['X-Content-Type-Options'], 'nosniff', `${name} 不许浏览器自己猜类型`);
    assert.match(h['Content-Security-Policy'] ?? '', /sandbox/, `${name} 就算被当页面打开也跑不了脚本`);
  }
});

test('downloadUpload：普通图片照常直接显示（缩略图靠它）', () => {
  for (const [name, type] of [['pic.png', 'image/png'], ['pic.jpeg', 'image/jpeg'], ['pic.gif', 'image/gif']]) {
    const h = served(name, Buffer.from([1, 2, 3]));
    assert.equal(h['Content-Disposition'], undefined, `${name} 不该变成下载`);
    assert.equal(h['Content-Type'], type);
  }
});

// ── 符号链接穿透、路径脱敏与排他落盘 ────────────────────────

test('readUpload：拒绝符号链接与解析后越出上传目录的文件', () => {
  const cwd = tmp('baton-symlink-');
  saveUpload({ cwd, name: 'ok.txt', bytes: Buffer.from('ok') });

  // 1) 目标本身是符号链接（含 POSIX 或提权 Windows 文件符号链接）
  assert.throws(() => readUpload({
    cwd,
    name: 'ok.txt',
    lstat: () => ({ isSymbolicLink: () => true }),
    stat: () => ({ isFile: () => true, size: 2 }),
    read: () => Buffer.from('secret'),
  }), /符号链接/);

  // 2) realpath 解析后落到 .baton-uploads 之外
  const outside = path.join(os.tmpdir(), 'outside-secret.txt');
  assert.throws(() => readUpload({
    cwd,
    name: 'ok.txt',
    lstat: () => ({ isSymbolicLink: () => false }),
    stat: () => ({ isFile: () => true, size: 2 }),
    realpath: () => outside,
    read: () => Buffer.from('secret'),
  }), /上传目录之外/);

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uniquePath 默认按词法路径占位，防止悬挂符号链接欺骗与覆盖', () => {
  const cwd = tmp('baton-dangling-');
  const target = path.join(cwd, 'note.md');
  fs.writeFileSync(target, 'old');
  assert.equal(uniquePath(target), path.join(cwd, 'note-2.md'));
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('uploadTarget 拒绝外指目录链接时不向客户端泄露宿主机真实路径', () => {
  const cwd = tmp('baton-leak-');
  const outside = tmp('baton-secret-dir-999-');
  const linkPath = path.join(cwd, UPLOAD_DIR);
  let created = false;
  try {
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, outside], { stdio: 'ignore' });
    } else {
      fs.symlinkSync(outside, linkPath, 'dir');
    }
    created = true;
  } catch {
    // 无权限建链接则只测真实 cwd 场景
  }
  if (created) {
    assert.throws(() => uploadTarget(cwd, 'a.txt'), (err) => {
      assert.match(err.message, /工作目录之外/);
      assert.ok(!err.message.includes(path.basename(outside)), '错误信息不得回显宿主机真实目标目录');
      return true;
    });
  }
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
