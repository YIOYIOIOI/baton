import fs from 'node:fs';
import path from 'node:path';
import { joinPath } from '../DirSheet';

/**
 * 工作目录选择器对契约的几处硬约定。
 *
 * 这些全是**服务端已经知道、客户端照做就行**的事，做错了不会报错，只会在某个
 * 身份的人手上静默地坏掉——而那个人多半不是开发的时候坐在这儿的人。
 * 契约见 docs/ops/workspace-api-contract.md。
 */

const SRC = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8').replace(/\r/g, '');

/** 去掉注释——注释里大谈 owner 和访客是**应该的**（解释为什么不分支）。 */
const stripComments = (code: string) => code
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/**
 * 契约里点名的头号坑：「不要在客户端判断自己是 owner 还是访客，也不要加任何
 * 身份分支。服务端已经按调用者收窄过了，同一套 UI 两种身份都对；加了分支反而会错。」
 *
 * 「反而会错」是关键——客户端并不知道服务端按什么规则收的窄，自己再判一次
 * 只会和服务端对不上。而这种错在 owner 自己的机器上**永远测不出来**。
 */
test('客户端不做身份分支', () => {
  const files = ['components/DirSheet.tsx', 'app/new.tsx', 'api/client.ts', 'api/types.ts'];
  const bad: string[] = [];
  for (const f of files) {
    const code = stripComments(read(f));
    // 身份标识本身就不该出现在代码里（注释除外）
    for (const m of code.matchAll(/\b(isOwner|isGuest|guest|owner)\b/g)) {
      bad.push(`${f}: ${m[1]}`);
    }
  }
  expect(bad).toEqual([]);
});

/**
 * 候选目录必须来自服务端的 `cwds`，不能再自己遍历 chains 凑。
 *
 * 那段遍历对 owner 恰好等价，所以换不换他都看不出来；而**访客零会话时凑出来的是
 * 空选单，压根开不了头**。这正是「在 owner 机器上测不出来」的那类。
 */
test('新建页用服务端给的 cwds，不自己遍历 chains', () => {
  const code = read('app/new.tsx');
  expect(code).toMatch(/r\.cwds/);
  expect(stripComments(code)).not.toMatch(/members/);
  // 守一手旧守护进程：同仓一起发版，但它是常驻的，owner 未必重启过
  expect(code).toMatch(/Array\.isArray\(r\.cwds\)/);
});

/**
 * `readable: false` 的目录**必须不可点**。契约原话：「不要让用户点了才报错」。
 * 服务端已经知道点进去会失败，把它瞒到最后一刻是白费一次往返和一次失望。
 */
test('readable:false 的目录不可点', () => {
  const code = read('components/DirSheet.tsx');
  expect(code).toMatch(/disabled=\{!d\.readable \|\| busy\}/);
});

/** `parent: null` = 不能再往上。访客站在工作区根、owner 站在盘符根都是这样。 */
test('parent 为 null 时禁用上一级', () => {
  const code = read('components/DirSheet.tsx');
  expect(code).toMatch(/disabled=\{!listing\?\.parent \|\| busy\}/);
});

/**
 * 起点的 `path` 是 `null`——那是一组入口，不是某个目录的内容，所以那一屏
 * 不能有「用这个目录」。
 */
test('起点不给「用这个目录」', () => {
  const code = read('components/DirSheet.tsx');
  expect(code).toMatch(/const at = listing\?\.path \?\? null/);
  expect(code).toMatch(/\{at \? \(/);
});

/** 起点必须打接口拿，不能自己拼盘符——拼出来的对访客是错的。 */
test('起点走 GET /api/dirs，不自己拼盘符', () => {
  const code = read('components/DirSheet.tsx');
  expect(code).toMatch(/load\(null\)/);
  expect(stripComments(code)).not.toMatch(/[A-Z]:\\\\/);
});

/**
 * 三个 cwd 错误码里**只有** `cwd_not_found` 能就地补救。
 * 给 `cwd_not_allowed` 也配个「建一个」是骗人：建了还是越界，服务端照样拒。
 */
test('只有 cwd_not_found 给「建一个」', () => {
  const code = read('app/new.tsx');
  expect(code).toMatch(/err\.code === 'cwd_not_found'/);
  expect(stripComments(code)).not.toMatch(/cwd_not_allowed|bad_cwd/);
});

/** 新建目录归在 allowSend 之下——它往 owner 的磁盘上写东西。 */
test('只读模式下不给新建文件夹', () => {
  const code = read('components/DirSheet.tsx');
  expect(code).toMatch(/allowSend !== false/);
  expect(code).toMatch(/client\?\.health\(\)/);
});

/** 建完要用**服务端返回的**路径，它是归一化过的，不一定和我拼的逐字相同。 */
test('建完进的是服务端返回的路径', () => {
  expect(read('components/DirSheet.tsx')).toMatch(/await load\(made\.path\)/);
});

/**
 * 拼路径的分隔符照 base 里已有的那个来，**不按平台猜**：路径来自服务端，
 * 那台电脑是 Windows 还是 POSIX 由它说了算，手机这边无从判断。
 */
describe('joinPath', () => {
  test('Windows 路径用反斜杠', () => {
    expect(joinPath('C:\\workspace', 'baton')).toBe('C:\\workspace\\baton');
  });

  test('盘符根本来就以分隔符结尾，不能拼成两个', () => {
    expect(joinPath('C:\\', 'proj')).toBe('C:\\proj');
  });

  test('POSIX 路径用正斜杠', () => {
    expect(joinPath('/home/y/work', 'proj')).toBe('/home/y/work/proj');
  });

  test('POSIX 根同理', () => {
    expect(joinPath('/', 'proj')).toBe('/proj');
  });

  test('不按运行平台猜——手机是 iOS，但路径可能是 Windows 的', () => {
    expect(joinPath('D:\\a\\b', 'c')).not.toContain('/');
  });
});
