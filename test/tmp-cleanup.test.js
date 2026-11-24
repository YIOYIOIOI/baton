import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpDir } from './helpers.js';

/*
  测试建的临时目录，进程退出时要删掉。

  原来从来不删：2026-10-01 数过，%TEMP% 里攒了 93,719 个 baton-* 目录，从 09-10 开工起
  一个没少。只能按进程各删各的：node --test 并行起多个进程跑测试文件，按前缀批量删
  会删到别的进程正在用的目录。
*/
test('tmpDir 建的目录和 BATON_DIR 临时家目录，进程一退就删掉', () => {
  const helpers = new URL('./helpers.js', import.meta.url).href;
  const setup = new URL('./setup.js', import.meta.url).href;
  const env = { ...process.env };
  delete env.BATON_DIR; // 让子进程里的 setup.js 自己建一个
  const out = spawnSync(process.execPath, ['--import', setup, '--input-type=module', '-e', `
    import { tmpDir } from ${JSON.stringify(helpers)};
    console.log(JSON.stringify({ made: [tmpDir(), tmpDir('baton-other-')], home: process.env.BATON_DIR }));
  `], { encoding: 'utf8', env });
  assert.equal(out.status, 0, out.stderr);
  const { made, home } = JSON.parse(out.stdout);
  for (const d of [...made, home]) assert.equal(fs.existsSync(d), false, `${d} 应当已经删掉`);
});

test('预加载隔离调用方已有的数据目录，不读取或清理其中的状态', () => {
  const existing = tmpDir();
  const marker = path.join(existing, 'push.json');
  fs.writeFileSync(marker, '{}');
  const setup = new URL('./setup.js', import.meta.url).href;
  const out = spawnSync(process.execPath, ['--import', setup, '--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    const dir = process.env.BATON_DIR;
    console.log(JSON.stringify({ dir, inherited: fs.existsSync(path.join(dir, 'push.json')) }));
  `], { encoding: 'utf8', env: { ...process.env, BATON_DIR: existing } });
  assert.equal(out.status, 0, out.stderr);
  const { dir, inherited } = JSON.parse(out.stdout);
  assert.notEqual(dir, existing);
  assert.equal(inherited, false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(marker, 'utf8'), '{}');
});
