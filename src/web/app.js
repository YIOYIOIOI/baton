// Baton 前端。纯函数具名导出供 node:test 引入；
// 浏览器运行时代码在 document 存在的分支里，node 下不执行。

const AGENT_LABEL = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };

// ── 纯函数 ────────────────────────────────────────

// 跨域重定向对 fetch 是不透明的（type: 'opaqueredirect'）。EventSource 自己拿不到
// 跳转目标，所以必须靠一次 redirect:'manual' 的探测来区分四态。
//
// 这个分支原本叫 access_expired——Cloudflare Access 会话过期的指纹。2026-09-12
// Access 已撤，但**分支不能删**：公司网的强制门户（captive portal）同样以 302
// 拦截，行为一模一样。改名为 intercepted，因为现在能确定的只是「有东西在中间
// 拦了」，确定不了是谁。重新登录的指引因此也不能再写死成 Access。
export function classifyConnectionFailure(probe) {
  if (!probe || probe.error) return 'offline';
  if (probe.type === 'opaqueredirect') return 'intercepted';
  if (probe.status >= 300 && probe.status < 400) return 'intercepted';
  if (probe.status === 401) return 'unpaired';
  return 'transient';
}

// 第 1 档标题与桌面 App 同源；其余由 Baton 推导，需要如实标注。
// 返回可读说明而非记号——它进 tooltip 与 aria-label，比一个 ~ 前缀有用。
export function tierMarker(titleTier) {
  if (titleTier === 1) return '';
  return '这个标题由 Baton 从会话内容推导，不保证与桌面显示一致';
}

export function renderEventText(event) {
  switch (event.kind) {
    case 'text':
    case 'thinking':
      return event.text ?? '';
    case 'tool_call': {
      const input = typeof event.tool?.input === 'string'
        ? event.tool.input
        : JSON.stringify(event.tool?.input ?? null);
      return input ?? '';
    }
    case 'tool_result':
      return event.tool?.output ?? '';
    case 'turn_end':
      return event.error ? `本轮失败：${event.error}` : '本轮完成';
    case 'interrupt':
      // 服务端已经翻成了给人看的话（src/claude.js 的 interruptOf），而且一定给——
      // 这里不再写后备措辞：同一句话写第二份，迟早说成两种话（test/event-kinds.test.js）
      return event.text ?? '';
    case 'command_output':
      // 斜杠命令的回执（2026-11-10），原文照给
      return event.text ?? '';
    case 'goal':
      // /goal 的进度：text 是目标条件
      return `${event.goal?.met ? '目标达成' : '目标还没达成'}：${event.text ?? ''}`;
    default:
      return '';
  }
}

// 哪些失败是 Baton 自己的问题（必须让人看见），哪些只是暂时取不到（静默降级）。
// not_found = 端点不存在，是路由漏了；asset_missing = 部署不全。
// 这两类一律静默会让硬故障看起来像正常降级。
const CLIENT_FAULT_CODES = new Set(['not_found', 'asset_missing']);

export function isClientFault(err) {
  return CLIENT_FAULT_CODES.has(err?.code);
}

export function composerState({ allowSend }) {
  if (allowSend === true) return { disabled: false, hint: '' };
  return {
    disabled: true,
    hint: '只读模式。在电脑上编辑 ~/.baton/config.json 设 "allowSend": true，重启 Baton 后即可发送。',
  };
}

export function statusLine(state) {
  if (state?.running) return '这一轮正在进行中…';
  const t = state?.latestTurn;
  if (!t) return '';
  if (t.status === 'failed') return `上一轮失败：${t.error ?? '未给出原因'}`;
  if (t.status === 'anomaly') return `上一轮异常：${t.error ?? '未给出原因'}`;
  if (t.status === 'aborted') return '上一轮已被停止。';
  return '';
}

// 会话的说话人。origin 来自 transcript 的 promptSource，
// 能区分「手机发的」与「电脑手打的」——跨设备场景下用户想知道这个。
export function speakerLabel(event, agent) {
  if (event.role === 'user') {
    // origin==='sdk' 表示这条消息由程序发送（Baton 走 -p 就是这一类）。
    // 缺失只说明「没有该标记」，不能反证是在 App 里手打的，故不加设备后缀。
    if (event.origin === 'sdk') return '你 · 远程发送';
    return '你';
  }
  if (event.role === 'agent') return AGENT_LABEL[agent] ?? agent;
  return '';
}

export function dirName(cwd) {
  if (!cwd) return '';
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
}

// ── 浏览器运行时 ──────────────────────────────────

if (typeof document !== 'undefined') {
  const $ = (id) => document.getElementById(id);
  const state = { key: null, agent: null, nextBefore: null, es: null, backoffMs: 1000, allowSend: false };

  const show = (which) => {
    for (const id of ['pair', 'list', 'convo']) $(id).hidden = id !== which;
  };

  function banner(text, onClick) {
    const el = $('banner');
    el.hidden = !text;
    el.textContent = text ?? '';
    el.onclick = onClick ?? null;
    if (onClick) el.dataset.clickable = '1';
    else delete el.dataset.clickable;
  }

  async function probeConnection() {
    try {
      const res = await fetch('/api/health', { redirect: 'manual', cache: 'no-store' });
      return { type: res.type, status: res.status, ok: res.ok };
    } catch {
      return { error: true };
    }
  }

  async function handleFailure() {
    const verdict = classifyConnectionFailure(await probeConnection());
    if (verdict === 'intercepted') {
      banner('请求被中途拦截，多半是网络的登录页。在浏览器里打开任意网站登录后，点这里重试。',
        () => window.location.reload());
      return 'stop';
    }
    if (verdict === 'unpaired') {
      banner(null);
      show('pair');
      return 'stop';
    }
    if (verdict === 'offline') {
      banner('已离线，正在重试…');
      return 'retry';
    }
    banner(null);
    return 'retry';
  }

  async function api(path, opts) {
    const res = await fetch(path, { redirect: 'manual', cache: 'no-store', ...opts });
    if (!res.ok || res.type === 'opaqueredirect') {
      const verdict = classifyConnectionFailure({ type: res.type, status: res.status, ok: res.ok });
      if (verdict === 'unpaired') { show('pair'); throw new Error('unpaired'); }
      if (verdict === 'intercepted') { await handleFailure(); throw new Error('intercepted'); }
      const body = await res.json().catch(() => null);
      const err = new Error(body?.error ? `${body.error.message} ${body.error.fix}` : `HTTP ${res.status}`);
      // 把错误码带出来：调用方要能区分「Baton 自己的 bug」与「暂时取不到」
      err.code = body?.error?.code ?? null;
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  // 分段轨道：段数 = 链上的会话数，实心尖端 = 当前那一条
  function track(count) {
    const el = document.createElement('span');
    el.className = 'track';
    el.setAttribute('aria-label', count > 1 ? `${count} 个分支` : '单一会话');
    for (let i = 0; i < count; i += 1) {
      if (i > 0) {
        const rail = document.createElement('span');
        rail.className = 'rail';
        el.append(rail);
      }
      const node = document.createElement('span');
      node.className = i === count - 1 ? 'node tip' : 'node';
      el.append(node);
    }
    return el;
  }

  function renderChains(chains) {
    $('count').textContent = `${chains.length} 条`;
    $('chains').replaceChildren(...chains.map((c) => {
      const latest = c.members.at(-1);
      const li = document.createElement('li');
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'chain';
      card.dataset.agent = c.agent;

      const title = document.createElement('div');
      title.className = 'chain-title';
      title.textContent = latest.title;
      const note = tierMarker(latest.titleTier);
      if (note) {
        title.classList.add('derived');
        title.title = note;
        title.setAttribute('aria-description', note);
      }

      const foot = document.createElement('div');
      foot.className = 'chain-foot';
      const dir = document.createElement('span');
      dir.className = 'chain-dir';
      dir.textContent = dirName(latest.cwd);
      const agent = document.createElement('span');
      agent.className = 'chain-agent';
      agent.textContent = AGENT_LABEL[c.agent] ?? c.agent;
      foot.append(track(c.members.length), dir, agent);

      card.append(title, foot);
      card.onclick = () => openSession(c.agent, latest);
      li.append(card);
      return li;
    }));
  }

  function eventNode(e, fresh) {
    const li = document.createElement('li');
    li.className = fresh ? 'ev fresh' : 'ev';
    li.dataset.role = e.role;

    const who = speakerLabel(e, state.agent);
    if (who) {
      const w = document.createElement('div');
      w.className = 'who';
      w.textContent = who;
      li.append(w);
    }

    const text = renderEventText(e);

    if (e.kind === 'thinking') {
      const d = document.createElement('details');
      d.className = 'think';
      const s = document.createElement('summary');
      s.textContent = '思考过程';
      const b = document.createElement('div');
      b.className = 'body';
      b.textContent = text;
      d.append(s, b);
      li.append(d);
    } else if (e.kind === 'tool_call' || e.kind === 'tool_result') {
      const wrap = document.createElement('div');
      wrap.className = 'tool';
      const name = document.createElement('div');
      name.className = 'tool-name';
      name.textContent = e.kind === 'tool_call' ? (e.tool?.name ?? '工具') : '输出';
      const pre = document.createElement('pre');
      pre.textContent = text;
      wrap.append(name, pre);
      li.append(wrap);
    } else if (e.kind === 'turn_end') {
      const t = document.createElement('div');
      t.className = e.error ? 'turn bad' : 'turn';
      t.textContent = text;
      li.append(t);
    } else {
      const b = document.createElement('div');
      b.className = 'body';
      b.textContent = text;
      li.append(b);
    }
    return li;
  }

  function appendEvents(events, { prepend = false, fresh = false } = {}) {
    const nodes = events.map((e) => eventNode(e, fresh));
    if (prepend) $('events').prepend(...nodes);
    else $('events').append(...nodes);
  }

  // 重连先拉状态再订阅推送：断连期间发生的事不能凭空消失，
  // 页面不能停在旧画面装作没事（spec §12）
  async function refreshStatus() {
    try {
      const s = await api(`/api/sessions/${encodeURIComponent(state.key)}/state`);
      state.running = s.running === true;
      const line = statusLine(s);
      $('convo-status').hidden = !line;
      $('convo-status').textContent = line;
      $('convo-status').classList.toggle(
        'bad', s.latestTurn?.status === 'failed' || s.latestTurn?.status === 'anomaly',
      );
      $('stop').hidden = !s.running;
      state.runningTurnId = s.running ? s.latestTurn?.turnId ?? null : null;
    } catch (err) {
      // 「暂时取不到」该静默降级；「服务端说没这个端点」是 bug，必须可见。
      // 一律静默会把硬故障伪装成正常降级——/state 的路由曾因此漏了一整轮没被发现。
      if (isClientFault(err)) {
        banner(`运行态取不到：${err.message}`);
      }
      $('stop').hidden = true;
    }
  }

  async function openSession(agent, member) {
    state.key = member.key;
    state.agent = agent;
    $('convo-title').textContent = member.title;
    $('events').replaceChildren();
    $('convo-status').hidden = true;
    show('convo');
    await refreshStatus();
    const page = await api(`/api/sessions/${encodeURIComponent(member.key)}/events?limit=50`);
    state.nextBefore = page.nextBefore;
    appendEvents(page.events);
    $('load-earlier').hidden = state.nextBefore === null;
    applyComposer();
    subscribe();
  }

  function subscribe() {
    state.es?.close();
    const es = new EventSource(`/api/sessions/${encodeURIComponent(state.key)}/stream`);
    state.es = es;
    es.addEventListener('events', (ev) => {
      state.backoffMs = 1000;
      banner(null);
      appendEvents(JSON.parse(ev.data).events, { fresh: true });
      window.scrollTo(0, document.body.scrollHeight);
      refreshStatus();
    });
    es.onerror = async () => {
      es.close();
      if (await handleFailure() === 'stop') return;
      setTimeout(async () => {
        // 重连的第一件事是拉状态，不是直接续订阅
        await refreshStatus();
        subscribe();
      }, state.backoffMs);
      state.backoffMs = Math.min(state.backoffMs * 2, 30000);
    };
  }

  $('load-earlier').onclick = async () => {
    if (state.nextBefore === null) return;
    const page = await api(
      `/api/sessions/${encodeURIComponent(state.key)}/events?limit=50&before=${state.nextBefore}`,
    );
    state.nextBefore = page.nextBefore;
    appendEvents(page.events, { prepend: true });
    $('load-earlier').hidden = state.nextBefore === null;
  };

  function applyComposer() {
    const s = composerState({ allowSend: state.allowSend });
    $('msg').disabled = s.disabled;
    $('send').disabled = s.disabled;
    $('fork').disabled = s.disabled;
    $('composer-hint').hidden = !s.hint;
    $('composer-hint').textContent = s.hint;
  }

  async function postMessage(text, { fork = false } = {}) {
    await api(`/api/sessions/${encodeURIComponent(state.key)}/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: text, fork }),
    });
  }

  $('composer').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('msg').value;
    if (!text.trim()) return;
    $('send').disabled = true;
    try {
      await postMessage(text);
      // 回显由 tail-follow 从 transcript 推回来，不在本地伪造
      $('msg').value = '';
    } catch (err) {
      if (err.message !== 'unpaired' && err.message !== 'intercepted') banner(err.message);
    } finally {
      applyComposer();
    }
  };

  $('fork').onclick = async () => {
    const text = $('msg').value.trim();
    if (!text) { banner('分叉需要先写一条消息作为新会话的第一句。'); return; }
    if (!window.confirm('从当前末尾分叉出一个新会话？原会话不受影响。')) return;
    $('fork').disabled = true;
    try {
      await postMessage(text, { fork: true });
      $('msg').value = '';
      banner('已发起分叉。新会话会在列表刷新后出现在同一条链下。');
    } catch (err) {
      if (err.message !== 'unpaired' && err.message !== 'intercepted') banner(err.message);
    } finally {
      applyComposer();
    }
  };

  /**
   * 新建会话的目录选项：直接用 `/api/sessions` 返回的 `cwds`，不自由输入。
   *
   * **不要再遍历 chains 自己凑。** 那个做法对 owner 恰好等价，但访客零会话时
   * 得到的是一个空选单，压根开不了头（docs/ops/workspace-api-contract.md §1）。
   * `cwds` 是服务端按调用者算好的，对访客至少含他自己的工作区根。
   *
   * 这套老界面只接契约的第 1 条。目录浏览与新建文件夹（§2、§3）留在 web/ 那套里：
   * 这里是零构建的兜底界面，为它手写一个目录浏览器不划算。
   */
  function fillCwdOptions(cwds) {
    const dirs = cwds ?? [];
    $('new-cwd').replaceChildren(...dirs.map((d) => {
      const o = document.createElement('option');
      o.value = d;
      o.textContent = dirName(d);
      o.title = d;
      return o;
    }));
    $('new-toggle').disabled = dirs.length === 0 || !state.allowSend;
  }

  $('new-toggle').onclick = () => {
    const f = $('new-form');
    f.hidden = !f.hidden;
    if (!f.hidden) $('new-msg').focus();
  };
  $('new-cancel').onclick = () => { $('new-form').hidden = true; };

  $('new-form').onsubmit = async (e) => {
    e.preventDefault();
    const message = $('new-msg').value;
    if (!message.trim()) return;
    $('new-submit').disabled = true;
    $('new-hint').hidden = false;
    $('new-hint').textContent = '正在新建会话，agent 首轮可能要几十秒…';
    try {
      const body = await api('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agent: $('new-agent').value, cwd: $('new-cwd').value, message,
        }),
      });
      $('new-msg').value = '';
      $('new-form').hidden = true;
      banner(body.note);
      load();
    } catch (err) {
      if (err.message !== 'unpaired' && err.message !== 'intercepted') {
        $('new-hint').textContent = err.message;
      }
    } finally {
      $('new-submit').disabled = false;
    }
  };

  $('stop').onclick = async () => {
    if (!state.runningTurnId) { banner('这一轮已经结束了。'); return; }
    $('stop').disabled = true;
    try {
      const body = await api(`/api/sessions/${encodeURIComponent(state.key)}/stop`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turnId: state.runningTurnId }),
      });
      banner(body.stopped ? '已停止这一轮。' : body.note);
      await refreshStatus();
    } catch (err) {
      if (err.message !== 'unpaired' && err.message !== 'intercepted') banner(err.message);
    } finally {
      $('stop').disabled = false;
    }
  };

  $('back').onclick = () => { state.es?.close(); load(); };
  $('refresh').onclick = () => load();

  $('pair-form').onsubmit = async (e) => {
    e.preventDefault();
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: $('pair-code').value.trim().toUpperCase() }),
    });
    if (res.ok) { $('pair-error').hidden = true; load(); return; }
    const body = await res.json().catch(() => null);
    $('pair-error').hidden = false;
    $('pair-error').textContent = body?.error
      ? `${body.error.message} ${body.error.fix}`
      : '配对失败。请在电脑终端重新取一个配对码。';
  };

  async function load() {
    try {
      const health = await api('/api/health');
      state.allowSend = health.allowSend === true;
      const { chains, cwds } = await api('/api/sessions');
      renderChains(chains);
      fillCwdOptions(cwds);
      show('list');
    } catch (err) {
      if (err.message !== 'unpaired' && err.message !== 'intercepted') banner(err.message);
    }
  }

  load();
}
