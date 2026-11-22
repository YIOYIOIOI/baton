#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FORBIDDEN_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'token',
  'principals.json',
  'revoked.json',
  'devices.json',
  'daemon-process.json',
  'daemon-wrapper.json',
  'push.json',
  'CLAUDE.local.md',
  'pairing-qr.svg',
]);

const FORBIDDEN_EXTS = new Set([
  '.pem',
  '.key',
  '.p8',
  '.p12',
  '.jks',
  '.keystore',
  '.mobileprovision',
  '.tsbuildinfo',
]);

const SYNTHETIC_USERS = new Set([
  'alice', 'bob', 'user', 'u', 'a', 'y', 'me', 'coder', 'example', 'demo', 'dev', 'runner', 'ubuntu', 'teammate', 'username', 'your-name',
]);

const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.css', '.html', '.yml', '.yaml', '.ps1', '.sh', '.cmd', '.svg', '.plist',
  '.jsonl', '.ndjson', '.map', '.toml',
]);

const SECRET_RULES = [
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'openai-key', re: /\bsk-(?:proj|svcacct)-[A-Za-z0-9_-]{16,}\b/g },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { id: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { id: 'jwt-token', re: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: 'cf-tunnel-secret', re: /"TunnelSecret"\s*:\s*"(?!<[A-Za-z0-9_-]+>|REDACTED\b|PLACEHOLDER\b|\*{4,}|x{8,})([A-Za-z0-9+/=]{24,})"/gi },
];

export function scanPathName(relPath) {
  const norm = String(relPath).replace(/\\/g, '/');
  const base = path.posix.basename(norm);
  const ext = path.posix.extname(base).toLowerCase();
  if (FORBIDDEN_BASENAMES.has(base)) {
    return [`forbidden runtime/secret file tracked: ${norm}`];
  }
  if (FORBIDDEN_EXTS.has(ext)) {
    return [`forbidden sensitive extension (${ext}) tracked: ${norm}`];
  }
  if (base.endsWith('.local.md')) {
    return [`forbidden local-only markdown tracked: ${norm}`];
  }
  return [];
}

function isSyntheticHomeName(name) {
  const lower = name.toLowerCase();
  if (SYNTHETIC_USERS.has(lower)) return true;
  if (/^[<${%]/.test(name) || /^\.+$/.test(name)) return true;
  return false;
}

export function scanText(relPath, content) {
  const findings = [];
  const norm = String(relPath).replace(/\\/g, '/');
  for (const rule of SECRET_RULES) {
    rule.re.lastIndex = 0;
    const m = rule.re.exec(content);
    if (m) {
      findings.push(`${norm}: matched forbidden secret rule [${rule.id}]`);
    }
  }

  // Emscripten sets this exact virtual HOME in its browser runtime.
  const homePaths = content.replace(/\bHOME:\s*(["'])\/home\/web_user\1/g, '');
  for (const m of homePaths.matchAll(/(?:[A-Za-z]:\\+Users\\+|\/Users\/|\/home\/)([A-Za-z0-9._$%{}<>-]+)/g)) {
    const user = m[1];
    if (!isSyntheticHomeName(user)) {
      findings.push(`${norm}: suspicious non-synthetic home path segment`);
    }
  }
  return findings;
}

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitBuf(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function scanBytes(rel, data) {
  if (data[0] === 0xff && data[1] === 0xfe) return scanText(rel, data.toString('utf16le'));
  if (data[0] === 0xfe && data[1] === 0xff && data.length % 2 === 0) return scanText(rel, data.swap16().toString('utf16le'));
  if (!data.includes(0)) return scanText(rel, data.toString('utf8'));
  if (TEXT_EXTS.has(path.posix.extname(rel).toLowerCase())) return [`${rel}: unexpected NUL in text file`];
  // Compiled assets can still carry literal strings in their data sections.
  return scanText(rel, data.toString('latin1'));
}

export function verifyRepoClean({ cwd = process.cwd(), ref = null, orphan = false } = {}) {
  const errors = [];

  if (orphan) {
    if (!ref) {
      errors.push('--orphan requires --ref <git-ref>');
    } else {
      const headers = git(['cat-file', '-p', `${ref}^{commit}`], cwd).split('\n\n', 1)[0];
      if (/^parent /m.test(headers)) {
        errors.push(`expected a zero-parent commit on ${ref}`);
      }
    }
  }

  const filesOut = ref
    ? git(['ls-tree', '-r', '-z', '--name-only', ref], cwd)
    : git(['ls-files', '-z'], cwd);
  const files = filesOut.split('\0').filter(Boolean);

  for (const rel of files) {
    errors.push(...scanPathName(rel));
    const ext = path.posix.extname(rel).toLowerCase();
    if (ext && !TEXT_EXTS.has(ext)) continue;

    let buf;
    if (ref) {
      buf = gitBuf(['show', `${ref}:${rel}`], cwd);
    } else {
      const abs = path.join(cwd, rel);
      let lst;
      try {
        lst = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (lst.isSymbolicLink()) {
        const target = fs.readlinkSync(abs, 'utf8');
        errors.push(...scanText(rel, target));
        continue;
      }
      if (!lst.isFile()) {
        errors.push(`non-regular file tracked: ${rel}`);
        continue;
      }
      if (lst.size > 16 * 1024 * 1024) {
        errors.push(`oversized file tracked (>16 MiB): ${rel}`);
        continue;
      }
      buf = fs.readFileSync(abs);
    }
    errors.push(...scanBytes(rel, buf));
  }

  return { ok: errors.length === 0, checkedFiles: files.length, errors };
}

// The package includes generated and ignored files that never appear in Git's tree.
export function verifyReleaseTree(root) {
  const errors = [];
  let checkedFiles = 0;
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      const rel = path.relative(root, file).split(path.sep).join('/');
      errors.push(...scanPathName(rel));
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      checkedFiles++;
      if (!entry.isFile()) {
        errors.push(`non-regular release entry: ${rel}`);
        continue;
      }
      errors.push(...scanBytes(rel, fs.readFileSync(file)));
    }
  }
  visit(root);
  return { ok: errors.length === 0, checkedFiles, errors };
}

function parseArgs(argv) {
  let ref = null;
  let orphan = false;
  let releaseDir = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--ref' && argv[i + 1]) ref = argv[++i];
    else if (argv[i] === '--release-dir' && argv[i + 1]) releaseDir = argv[++i];
    else if (argv[i] === '--orphan') orphan = true;
    else throw new Error(`Unknown flag: ${argv[i]}`);
  }
  if (releaseDir && (ref || orphan)) throw new Error('--release-dir scans an unpacked package independently of Git.');
  return { ref, orphan, releaseDir };
}

function main() {
  const { ref, orphan, releaseDir } = parseArgs(process.argv.slice(2));
  const res = releaseDir ? verifyReleaseTree(releaseDir) : verifyRepoClean({ ref, orphan });
  if (!res.ok) {
    console.error(`oss:check FAILED (${res.errors.length} finding(s) across ${res.checkedFiles} files):`);
    for (const e of res.errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log(`oss:check OK (${res.checkedFiles} ${releaseDir ? 'packaged' : 'tracked'} files clean${ref ? `, ref=${ref}` : ''}${orphan ? ', orphan=1' : ''})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
