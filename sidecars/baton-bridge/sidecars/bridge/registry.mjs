import fs from 'node:fs';
import path from 'node:path';

const uid = process.platform === 'win32' ? null : (process.geteuid?.() ?? process.getuid?.());
const safeRead = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

export function trustedRegistryEntry(stat, kind, owner = uid) {
  if (stat.isSymbolicLink()) return false;
  if (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) return false;
  if (owner === null) return true; // Windows uses the ACL of the owner's Baton data directory.
  return Number.isInteger(owner) && stat.uid === owner && (stat.mode & (kind === 'base' ? 0o022 : 0o077)) === 0;
}

// An unprivileged owner or writer of an ancestor could replace the entire registry.
// A system-owned sticky temp directory protects its already owner-owned children.
function verifyParents(base) {
  const visited = new Set();
  for (const location of [path.resolve(base), fs.realpathSync(base)]) {
    let child = location;
    for (let parent = path.dirname(child); parent !== child; parent = path.dirname(child)) {
      child = parent;
      if (visited.has(parent)) continue;
      visited.add(parent);
      const stat = fs.lstatSync(parent);
      if ((stat.uid !== uid && stat.uid !== 0) || (!stat.isSymbolicLink()
          && (!stat.isDirectory() || ((stat.mode & 0o022) && !(stat.mode & 0o1000))))) {
        throw new Error('桥接数据目录的上层路径可由其他用户替换');
      }
    }
  }
}

export function registryDirectory(batonDir, { publish = false } = {}) {
  if (publish) fs.mkdirSync(batonDir, { recursive: true, mode: 0o700 });
  if (!trustedRegistryEntry(fs.lstatSync(batonDir), 'base')) throw new Error('Baton 数据目录的归属或权限不允许安全登记桥接');
  if (uid !== null) verifyParents(batonDir);
  const dir = path.join(batonDir, 'antigravity-bridges');
  if (publish) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const before = fs.lstatSync(dir);
  if (publish && uid !== null && before.isDirectory() && !before.isSymbolicLink() && before.uid === uid && (before.mode & 0o077)) {
    const fd = fs.openSync(dir, safeRead | fs.constants.O_DIRECTORY);
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory() || opened.uid !== uid || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('桥接登记目录已变化');
      }
      fs.fchmodSync(fd, 0o700);
    } finally { fs.closeSync(fd); }
  }
  if (!trustedRegistryEntry(fs.lstatSync(dir), 'registry')) throw new Error('桥接登记目录的归属或权限不安全');
  return dir;
}

export function readRegistration(file) {
  const before = fs.lstatSync(file);
  if (!trustedRegistryEntry(before, 'file')) return null;
  const fd = fs.openSync(file, safeRead);
  try {
    const opened = fs.fstatSync(fd);
    if (!trustedRegistryEntry(opened, 'file') || before.dev !== opened.dev || before.ino !== opened.ino || opened.size > 16 * 1024) return null;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}
