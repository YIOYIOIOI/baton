/**
 * 没发出去的草稿，按会话存。手机端是同一个模型：app/src/store/drafts.ts。
 *
 * 原来草稿是 `Conversation` 自己的 useState，而调用处是 `<Conversation key={key}>`——
 * 切一次会话就整个重挂载，打了一半的字就没了。owner 在手机上撞到的是同一件事：
 * 「我打完字如果返回好像在回来的时候字会消失」。
 *
 * 存 localStorage，切会话、刷新都还在。每次都整份读、改一项、整份写，不在内存里
 * 另留一份：同时开着两个标签页时，各改各的会话不会互相盖掉。
 *
 * **附件不存**：离开这个会话时它们的 blob 预览会被 revoke（Conversation 里那段），
 * 留着只剩一张张裂图。
 */

/** 和手机端网页版同一个键、同一种格式，同一个浏览器里两套界面看到同一份草稿。 */
const STORE_KEY = 'baton.drafts';

/** 新建会话那一页的草稿。会话 key 形如 `claude:…`，撞不上它。 */
export const NEW_SESSION_DRAFT = 'new';

function readAll(): Record<string, unknown> {
  try {
    const o = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {}; // 隐私模式下 localStorage 会抛；坏了就当没有
  }
}

export function loadDraft(key: string): string {
  const v = readAll()[key];
  return typeof v === 'string' ? v : '';
}

export function saveDraft(key: string, text: string): void {
  const all = readAll();
  // 清空就删掉这一项，别攒一堆空字符串
  if (text) all[key] = text;
  else delete all[key];
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    // 存不上的代价只是「刷新之后草稿没了」，不能因此打断打字
  }
}
