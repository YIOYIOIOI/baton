import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR, loadConfig } from './config.js';
import { under } from './scope.js';

export const OWNER_ID = 'owner';

// owner 就是「没有 roots 的那一个」。这不是特例分支，而是 inScope 的边界值：
// roots === null 恒真。allowSend 为 null 表示继承全局配置。
export const OWNER = Object.freeze({
  id: OWNER_ID, name: OWNER_ID, roots: null, allowSend: null,
});

// id 会进 HMAC 的 salt 字符串，保持无聊
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 读 ~/.baton/principals.json。
 *
 * **任何一条不合法都只跳过那一条并记一条可操作的 errors，绝不抛。**
 * 抛出去会让守护进程起不来，而起不来的后果比少一个访客严重得多。
 * 调用方（cli.js）负责把 errors 印在启动横幅里——不静默是硬要求。
 */
/** @param {{ dir?: string, workspacesRoot?: string }} [opts] */
export function loadPrincipals({ dir = BATON_DIR, workspacesRoot } = {}) {
  const base = workspacesRoot ?? loadConfig({ dir }).workspacesRoot;
  const file = path.join(dir, 'principals.json');
  const errors = [];

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      errors.push(`${file} 读不了或不是合法 JSON（${err.message}）。已按「只有 owner」运行；`
        + '修好这个文件并重启 Baton 之后访客才会生效。');
    }
    return { principals: [OWNER], errors };
  }

  const staged = [];
  const seen = new Set();
  for (const g of Array.isArray(raw?.guests) ? raw.guests : []) {
    const id = typeof g?.id === 'string' ? g.id : '';
    if (!ID_RE.test(id)) {
      errors.push(`跳过一条访客：id ${JSON.stringify(g?.id)} 非法。`
        + '只允许小写字母、数字、下划线、短横线，首字符为字母或数字，最长 32。');
      continue;
    }
    if (id === OWNER_ID) {
      errors.push(`跳过访客 "${id}"：owner 是保留字，不能用作访客的 id。换一个 id。`);
      continue;
    }
    if (seen.has(id)) {
      errors.push(`跳过重复的访客 "${id}"：同一个 id 只能出现一次，后面那条被忽略了。`);
      continue;
    }
    if (g.root !== undefined && (typeof g.root !== 'string' || !path.isAbsolute(g.root))) {
      errors.push(`跳过访客 "${id}"：root 必须是绝对路径（收到 ${JSON.stringify(g.root)}）。`
        + `整个删掉 root 这个字段则用默认值 ${path.join(base, id)}。`);
      continue;
    }
    seen.add(id);
    staged.push({
      id,
      name: typeof g.name === 'string' && g.name ? g.name : id,
      roots: [g.root ?? path.join(base, id)],
      allowSend: typeof g.allowSend === 'boolean' ? g.allowSend : null,
    });
  }

  // 嵌套检查必须在 root **解析之后**：id 唯一时默认 root 之间不可能嵌套，
  // 但一个自定义 root 完全可能落进另一个访客的默认 root 里，
  // 那样「这个会话属于谁」就有两个答案。
  const kept = [];
  for (const g of staged) {
    const clash = kept.find((k) => under(g.roots[0], k.roots[0]) || under(k.roots[0], g.roots[0]));
    if (clash) {
      errors.push(`跳过访客 "${g.id}"：它的 root ${g.roots[0]} 与 "${clash.id}" 的 `
        + `${clash.roots[0]} 互相嵌套，同一个会话会有两个归属。给它们各自独立的目录。`);
      continue;
    }
    kept.push(g);
  }

  return { principals: [OWNER, ...kept], errors };
}

/**
 * 访客的工作区目录不存在就建出来。
 *
 * 建而不是报错：路径是 owner 自己配的（或由默认值推出来的），不建的话
 * 访客第一步就撞墙，而他看到的错误只会指向一个他无权创建的目录。
 */
export function ensureRoots(principals, { mkdir = fs.mkdirSync, exists = fs.existsSync } = {}) {
  const out = [];
  for (const g of principals) {
    if (!g.roots) continue; // owner 没有 roots
    for (const root of g.roots) {
      if (exists(root)) {
        out.push({ id: g.id, root, created: false, error: null });
        continue;
      }
      try {
        mkdir(root, { recursive: true });
        out.push({ id: g.id, root, created: true, error: null });
      } catch (err) {
        // 建不出来不能拖垮启动：记下原因，由横幅报给 owner
        out.push({ id: g.id, root, created: false, error: err.message });
      }
    }
  }
  return out;
}
