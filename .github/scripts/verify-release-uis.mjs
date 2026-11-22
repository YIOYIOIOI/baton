import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node .github/scripts/verify-release-uis.mjs <release.tgz>');

function readTar(...args) {
  return execFileSync('tar', args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
}

const packed = new Set(readTar('-tzf', archive).trimEnd().split(/\r?\n/));
for (const ui of ['web', 'app']) {
  const prefix = `package/${ui}/dist/`;
  const entry = `${prefix}index.html`;
  if (!packed.has(entry)) throw new Error(`Missing release entry: ${entry}`);

  const html = readTar('-xOzf', archive, entry);
  const origin = 'https://release.invalid';
  let hasScript = false;
  for (const [, tag, ref] of html.matchAll(/<(script|link|img)\b[^>]*?\s(?:src|href)\s*=\s*["']([^"']+)["']/gi)) {
    const url = new URL(ref, origin);
    if (url.origin !== origin) continue;
    const asset = prefix + decodeURIComponent(url.pathname.slice(1));
    if (!packed.has(asset)) throw new Error(`${entry} references missing asset ${asset}`);
    if (tag.toLowerCase() === 'script') hasScript = true;
  }
  if (!hasScript) throw new Error(`${entry} has no packaged entry script`);

  // The entry also loads chunks and images indirectly, including Expo's assets/node_modules/.
  const dist = fileURLToPath(new URL(`../../${ui}/dist/`, import.meta.url));
  const built = readdirSync(dist, { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
  for (const file of built) {
    const relative = path.relative(dist, path.join(file.parentPath, file.name)).split(path.sep).join('/');
    if (!packed.has(prefix + relative)) throw new Error(`Missing built file: ${prefix}${relative}`);
  }
  console.log(`Verified ${entry} and all ${built.length} built files in ${ui}/dist`);
}
