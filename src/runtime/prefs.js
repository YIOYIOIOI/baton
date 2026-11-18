import fs from 'node:fs';
import path from 'node:path';
import { BATON_DIR } from '../config.js';
import { isEffort } from '../agent/args.js';

/**
 * 每个会话选了哪个模型。
 *
 * 落盘而不是让客户端每次带上来，理由是本项目的目标之一就是**两端看到同一件事**：
 * 在手机上把某个会话切到 opus，回电脑上再发，不该悄悄切回去。让客户端带参数
 * 等于把状态放在了设备上，两台设备立刻各说各话。
 *
 * 存的是选择，不是「当前实际用的模型」——没有记录时就是「没选过」，
 * 由 agent 用它自己的默认。不预填一个猜测值：那会把「没选过」和
 * 「选了正好等于默认的那个」混为一谈，而这两者在 UI 上该显示得不一样。
 */

const file = (dir) => path.join(dir, 'prefs.json');

function readAll(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(file(dir), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {}; // 没有、或者坏了——两种都当空。偏好丢了顶多回到默认，不值得为它报错
  }
}

function writeAll(dir, all) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `prefs.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
  fs.renameSync(tmp, file(dir));
}

/** 这个会话选的模型；没选过返回 null。 */
export function getModel(key, { dir = BATON_DIR } = {}) {
  const v = readAll(dir)[key];
  return typeof v?.model === 'string' && v.model ? v.model : null;
}

/**
 * 一条记录现在有两个字段（model / effort），所以**写一个不能冲掉另一个**。
 *
 * 原来是 `all[key] = { model, updatedAt }` 整条替换——那时只有一个字段，没问题；
 * 加了第二个之后再这么写，就是「改模型顺手把思考强度清了」，而且清得无声无息。
 *
 * 两个都空了才删掉整条：留一个 `{ updatedAt }` 的空壳没有意义，而这个文件
 * **每次发消息都要读一遍**，不该只增不减。
 */
function patch(key, fields, { dir, now }) {
  const all = readAll(dir);
  const next = { ...all[key], ...fields, updatedAt: now };
  for (const k of ['model', 'effort']) if (!next[k]) delete next[k];
  if (next.model || next.effort) all[key] = next;
  else delete all[key];
  writeAll(dir, all);
  return all[key] ?? null;
}

/** 传 null / '' 表示「清掉选择，回到 agent 默认」。 */
export function setModel(key, model, { dir = BATON_DIR, now = Date.now() } = {}) {
  patch(key, { model: model || null }, { dir, now });
  return model || null;
}

/**
 * 这个会话选的思考强度；没选过返回 null。
 *
 * 和模型同一条理由落盘：在手机上把某个会话调到 max，回电脑上接着发，
 * 不该悄悄掉回去。
 */
export function getEffort(key, { dir = BATON_DIR } = {}) {
  const v = readAll(dir)[key];
  return typeof v?.effort === 'string' && v.effort ? v.effort : null;
}

export function setEffort(key, effort, { dir = BATON_DIR, now = Date.now() } = {}) {
  patch(key, { effort: effort || null }, { dir, now });
  return effort || null;
}

export function allModels({ dir = BATON_DIR } = {}) {
  const all = readAll(dir);
  const out = {};
  for (const [k, v] of Object.entries(all)) if (v?.model) out[k] = v.model;
  return out;
}

/**
 * 丢掉已经不存在的会话留下的偏好。启动时跑一次。
 *
 * 与 queue 的 reconcileQueues、intents 的 reconcileOrphans 是同一条纪律：
 * 凡是以会话 key 索引的落盘状态，都要能在会话消失后自己清掉。
 * 不清的话这个文件只增不减，而它在**每次发消息时都要读一遍**。
 */
/** @param {{ repo: { getSession(key: string): unknown }, dir?: string }} opts */
export function reconcilePrefs({ repo, dir = BATON_DIR }) {
  const all = readAll(dir);
  const dropped = [];
  for (const key of Object.keys(all)) {
    if (!repo.getSession(key)) {
      delete all[key];
      dropped.push(key);
    }
  }
  if (dropped.length) writeAll(dir, all);
  return dropped;
}

// ── 整台电脑的默认强度 ────────────────────────────

/**
 * 会话**连模型带强度都没单独选过**时，Baton 带哪一档强度，按 agent。
 *
 * owner：「默认改成opus5.5max」。CLI 自己的默认是 Opus 5.5 · 1M · medium，而 max
 * 写不进 Claude Code 的配置——settings.json 的 effortLevel 只认四档，写了 max 等于
 * 没写（docs/ops/agent-protocol.md §8）。所以由 Baton 起进程时带上 `--effort`。
 * 模型那一半不钉：实测显式传 `claude-opus-5-5` 会丢掉 1M 上下文，而不传时 CLI 的
 * 默认正好是 Opus 5.5 · 1M。
 *
 * 存 config.json 的 `defaultEffort`，与 permissionMode 同一个文件、同一个读法：
 * 每次用的时候从盘上读，改了不用重启守护进程。没配 = null = 跟 CLI 自己的默认。
 */
function readConfig(dir) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export function getDefaultEffort(agent, { dir = BATON_DIR } = {}) {
  const v = readConfig(dir).defaultEffort?.[agent];
  // 认不得的档位当没配：它最后要进 argv，脏值不能靠下游兜
  return isEffort(v) ? v : null;
}

/** 只改这一个 agent 的这一项，config.json 里别的键原样留着。传 null 是清掉。 */
export function setDefaultEffort(agent, effort, { dir = BATON_DIR } = {}) {
  if (effort !== null && !isEffort(effort)) {
    throw new Error(`未知的思考强度：${JSON.stringify(effort)}（agent=${agent}）`);
  }
  const current = readConfig(dir);
  const next = { ...current.defaultEffort, [agent]: effort };
  if (!effort) delete next[agent];
  const out = { ...current, defaultEffort: next };
  if (!Object.keys(next).length) delete out.defaultEffort;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return effort;
}

/**
 * 这一轮实际带哪档强度。会话自己选过的优先；都没选时才用整台电脑的默认，
 * 而且**只在模型也没选时**：默认强度是配给默认模型的，换了个模型未必认这一档。
 */
export function effectiveEffort({ model, effort, fallback }) {
  if (effort) return effort;
  return model ? null : (fallback ?? null);
}
