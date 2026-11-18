import {
  FLATTEN_CAP, arrange, baseName, clearPick, crumbsOf, flattenPicked, fmtSize, fmtTime, isTextName, kindOf,
  setSelecting, togglePick, useFilePick,
} from '../files';
import type { FileEntry, FileListing } from '@/api/types';

/**
 * 文件浏览器的纯逻辑。界面在 app/files/[key].tsx，这里钉住它依赖的几条规矩。
 */

const f = (name: string, size = 10, mtime = 0): FileEntry => ({ name, dir: false, size, mtime });
const d = (name: string, mtime = 0): FileEntry => ({ name, dir: true, size: null, mtime });

test('目录总在前面；名称按自然顺序（file2 在 file10 前面）', () => {
  const out = arrange([f('file10'), d('src'), f('file2'), d('app')], 'name', '').map((e) => e.name);
  expect(out).toEqual(['app', 'src', 'file2', 'file10']);
});

test('按时间、按大小都是降序，目录仍在前', () => {
  const list = [f('a', 5, 100), f('b', 50, 300), d('z', 1), f('c', 20, 200)];
  expect(arrange(list, 'mtime', '').map((e) => e.name)).toEqual(['z', 'b', 'c', 'a']);
  expect(arrange(list, 'size', '').map((e) => e.name)).toEqual(['z', 'b', 'c', 'a']);
});

test('筛选不分大小写，且不改原数组', () => {
  const list = [f('README.md'), f('readme.txt'), f('index.ts')];
  expect(arrange(list, 'name', 'READ').map((e) => e.name)).toEqual(['README.md', 'readme.txt']);
  expect(list.map((e) => e.name)).toEqual(['README.md', 'readme.txt', 'index.ts']);
});

test('面包屑：工作目录名打头，每段带上点它去哪', () => {
  expect(crumbsOf('', 'baton')).toEqual([{ name: 'baton', path: '' }]);
  expect(crumbsOf('app/src/store', 'baton')).toEqual([
    { name: 'baton', path: '' },
    { name: 'app', path: 'app' },
    { name: 'src', path: 'app/src' },
    { name: 'store', path: 'app/src/store' },
  ]);
});

test('绝对路径的末段：两种分隔符都认', () => {
  expect(baseName('C:\\workspace\\baton')).toBe('baton');
  expect(baseName('/home/me/baton/')).toBe('baton');
});

test('类型：和电脑端同一套分法；点开头的算配置', () => {
  expect(kindOf(d('src'))).toBe('dir');
  expect(kindOf(f('a.PNG'))).toBe('image');
  expect(kindOf(f('a.tsx'))).toBe('code');
  expect(kindOf(f('.gitignore'))).toBe('config');
  expect(kindOf(f('notes.md'))).toBe('doc');
  expect(kindOf(f('x.tgz'))).toBe('archive');
  expect(kindOf(f('blob.bin'))).toBe('file');
  expect(isTextName('Dockerfile')).toBe(true);
  expect(isTextName('photo.jpg')).toBe(false);
});

test('大小和时间的说法', () => {
  expect(fmtSize(null)).toBe('');
  expect(fmtSize(512)).toBe('512 B');
  expect(fmtSize(1536)).toBe('1.5 KB');
  expect(fmtSize(5 * 1048576)).toBe('5.0 MB');
  const now = new Date(2026, 10, 15, 10, 0).getTime();
  expect(fmtTime(null, now)).toBe('');
  expect(fmtTime(now - 30_000, now)).toBe('刚刚');
  expect(fmtTime(now - 5 * 60_000, now)).toBe('5 分钟前');
  expect(fmtTime(new Date(2026, 10, 15, 8, 5).getTime(), now)).toBe('今天 08:05');
  expect(fmtTime(new Date(2026, 10, 14, 23, 0).getTime(), now)).toBe('昨天 23:00');
  expect(fmtTime(new Date(2026, 2, 3, 9, 12).getTime(), now)).toBe('3/03 09:12');
  expect(fmtTime(new Date(2025, 11, 1).getTime(), now)).toBe('2025/12/1');
});

describe('勾选跨层保留、按会话隔离', () => {
  beforeEach(() => clearPick());

  test('勾的是完整相对路径，换了会话就是新的一批', () => {
    togglePick('s1', 'app/a.ts', false);
    togglePick('s1', 'docs', true);
    expect(useFilePick.getState()).toMatchObject({ key: 's1', selecting: true, picked: { 'app/a.ts': false, docs: true } });
    togglePick('s1', 'app/a.ts', false);
    expect(useFilePick.getState().picked).toEqual({ docs: true });
    togglePick('s2', 'x', false);
    expect(useFilePick.getState()).toMatchObject({ key: 's2', picked: { x: false } });
  });

  test('退出选择模式会清空', () => {
    togglePick('s1', 'a', false);
    setSelecting('s1', false);
    expect(useFilePick.getState()).toMatchObject({ selecting: false, picked: {} });
  });
});

describe('摊平勾中的东西', () => {
  const tree: Record<string, FileEntry[]> = {
    docs: [f('a.md'), d('img')],
    'docs/img': [f('x.png'), f('y.png')],
    empty: [],
  };
  const list = async (p: string): Promise<FileListing> => {
    if (!(p in tree)) throw new Error(`no ${p}`);
    return { cwd: '/w', path: p, parent: '', entries: tree[p] };
  };

  test('目录逐层展开，文件原样；不靠「列不了就当文件」去猜', async () => {
    const out = await flattenPicked(list, { docs: true, 'top.txt': false });
    expect(out.truncated).toBe(false);
    expect(out.files.sort()).toEqual(['docs/a.md', 'docs/img/x.png', 'docs/img/y.png', 'top.txt']);
  });

  test('空目录摊出来什么都没有', async () => {
    expect((await flattenPicked(list, { empty: true })).files).toEqual([]);
  });

  test('目录列不了就报错，不把它当成文件去下载', async () => {
    await expect(flattenPicked(list, { gone: true })).rejects.toThrow('no gone');
  });

  test('勾错了一个大目录时有上限', async () => {
    const big = Array.from({ length: FLATTEN_CAP + 50 }, (_, i) => f(`f${i}`));
    const out = await flattenPicked(async () => ({ cwd: '/w', path: 'big', parent: '', entries: big }), { big: true });
    expect(out.truncated).toBe(true);
    expect(out.files).toHaveLength(FLATTEN_CAP);
  });
});
