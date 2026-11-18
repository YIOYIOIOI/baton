import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
  测试建的临时目录，进程退出时删掉（见 tmp-cleanup.test.js）。原来从来不删，
  %TEMP% 里攒到了 9 万多个。每个进程只删自己建的：node --test 是多进程并行跑的。
*/
const made = [];
process.on('exit', () => {
  for (const d of made) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      // 删不掉（还有句柄开着）就算了，不能让测试因为收尾失败
    }
  }
});

export function tmpDir(prefix = 'baton-test-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

export function writeJsonl(dir, name, records) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
