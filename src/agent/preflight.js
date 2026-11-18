// 启动前 / 发送前的凭据检查与跨平台 OAuth 凭证读取。
//
// 实测（docs/ops/agent-protocol.md §6 / §12）：claude 的认证可走环境变量
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY，或 ~/.claude/.credentials.json，
// 在 macOS 上还会落在系统钥匙串 "Claude Code-credentials" 中。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve Claude Code config directory respecting CLAUDE_CONFIG_DIR. */
export function claudeConfigDir(env = process.env, home = os.homedir()) {
  return env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
}

/**
 * Read Claude OAuth JSON from macOS Keychain (`security find-generic-password`).
 * Returns `null` on non-macOS hosts or when the Keychain entry does not exist.
 */
export function readClaudeKeychain({ platform = process.platform, execFn = execFileSync } = {}) {
  if (platform !== 'darwin') return null;
  try {
    const raw = execFn('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const parsed = JSON.parse(String(raw ?? '').trim());
    return parsed?.claudeAiOauth ?? parsed ?? null;
  } catch {
    return null;
  }
}

/** Read Claude Code OAuth credentials from file first, falling back to macOS Keychain. */
export function readClaudeOAuth({
  home = os.homedir(),
  env = process.env,
  platform = process.platform,
  keychain = readClaudeKeychain,
} = {}) {
  const dir = claudeConfigDir(env, home);
  try {
    const oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth;
    if (oauth && (oauth.refreshToken || oauth.accessToken)) return oauth;
  } catch {
    // fall through to keychain on darwin
  }
  const kc = keychain({ platform });
  return kc && (kc.refreshToken || kc.accessToken) ? kc : null;
}

/** 电脑上的 claude 登没登录账号。只看凭据是否存在，不持久化值。 */
export function claudeLoggedIn(env = process.env, opts = {}) {
  return Boolean(readClaudeOAuth({ env, ...opts }));
}

export function missingCredentials(agent, env = process.env, loggedIn = claudeLoggedIn) {
  if (agent !== 'claude') return null;
  if (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY) return null;
  if (loggedIn(env)) return null;
  return 'ANTHROPIC_AUTH_TOKEN';
}

export const CREDENTIAL_FIX = 'Baton has not detected an API token or local Claude Code login. '
  + 'Account login: run `claude` and complete `/login`. '
  + 'API relay / custom key: ensure `ANTHROPIC_AUTH_TOKEN` (or `ANTHROPIC_API_KEY`) is exported in your environment, or restart Baton via `scripts\\start-daemon.ps1` on Windows.';
