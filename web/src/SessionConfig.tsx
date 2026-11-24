import { useCallback, useEffect, useState } from 'react';
import { Modal } from './Modal';
import {
  ApiError, api,
  type Agent, type AgentConfig, type ModelOption, type Models, type Permission, type SessionState,
} from './api';
import './sessionconfig.css';

/**
 * 会话的模型 / 思考强度 / 权限档位。
 *
 * ## 为什么在输入框上面挂一条常驻的摘要
 *
 * 它同时解决两件事，而第二件是原来完全缺的：
 *
 * 1. 是打开面板的入口
 * 2. **网页端原来根本看不出这个会话用的是哪个模型。** 三个端点后端一直有
 *    （`/api/sessions/:key/state` 甚至在 api.ts 里声明了却从没被调用过），
 *    网页端一个都没接
 *
 * ## 三件事放在一起，但不是一回事
 *
 * | | 落在哪 | 谁能改 |
 * |---|---|---|
 * | 模型 | **会话**（两台设备看到同一个选择） | 有效 allowSend 为 true 的身份 |
 * | 思考强度 | 会话 | 有效 allowSend 为 true 的身份 |
 * | 权限档位 | **全局、按 agent** | **只有 owner** |
 *
 * 权限那一格是全局的：改它会影响这台电脑上所有会话的下一轮。面板里如实写明，
 * 不然人会以为自己只改了眼前这一条。
 *
 * ## 三条不能自己判的事
 *
 * - **强度档位优先用所选模型的 `efforts`，给不出来才退回。** codex 那边是六档，
 *   逐模型不同（`codex debug models` 有目录）；claude 那边 `/api/models` 返回的是
 *   空数组——**那是「查不到目录」，不是「不支持」**，退回 `claude --help` 里那五档。
 *   这一条我写错过一次，详见 efforts 那段的注释
 * - **权限档位的 `available` 是服务端算的。** 这台机器 `codexSandbox: "missing"`，
 *   codex 四档里三档选了会**挂住**（实测 150 秒无响应）。禁用并显示服务端给的原因，
 *   不要自己推断
 * - **`canSet: false` 就是访客。** 先禁用不是替服务端把关（它照样 403），
 *   是别让人点了才挨一句拒绝
 */

/**
 * 两种用法，差别只在「模型和强度写到哪」：
 *
 *   绑了会话（会话页）  —— 写服务端，两台设备看到同一个选择
 *   没绑会话（新建页）  —— 只存本地，建会话那一刻一并带上；agent 这时才可切
 *
 * **权限档位两种用法下都是立即写全局的**，因为它本来就是全局按 agent 的设置，
 * 不属于任何一个会话。手机 app 的 SetupPill 也是这么分的。
 */
type Props =
  | { mode: 'session'; sessionKey: string; agent: Agent; running: boolean }
  | {
    mode: 'draft';
    agent: Agent;
    onAgent: (a: Agent) => void;
    model: string | null;
    onModel: (m: string | null) => void;
    effort: string | null;
    onEffort: (e: string | null) => void;
  };

/** 强度档位没有中文名——它对应 `codex -c model_reasoning_effort=<级别>`，用原名才对得上。 */
function effortLabel(e: string): string {
  return e;
}

function modelLabel(m: ModelOption): string {
  return m.name || m.id;
}

/** 1000000 → 1M。整数 token 数没人读得出量级。 */
function ctxLabel(n: number): string {
  return n >= 1_000_000 ? `${n / 1_000_000}M` : `${Math.round(n / 1000)}K`;
}

/**
 * 模型表、权限档位、每个会话的模型 / 强度，在这个标签页的内存里各留一份。
 *
 * 配置条挂在每个会话页底下，切会话、去设置页再回来都会重挂载它；不留的话每次都先闪一下
 * 「默认模型」再变成真的名字（模型表那个请求要等服务端问一次 claude，最慢十几秒）。
 * 先摆上次的，再照常去问，问回来覆盖。
 */
let modelsMemo: Models | null = null;
let permMemo: Permission | null = null;
const stateMemo = new Map<string, SessionState>();

export function SessionConfig(props: Props) {
  const { agent } = props;
  const sessionKey = props.mode === 'session' ? props.sessionKey : null;
  const running = props.mode === 'session' ? props.running : false;

  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SessionState | null>(() => (sessionKey ? stateMemo.get(sessionKey) ?? null : null));
  const [models, setModels] = useState<ModelOption[] | null>(() => modelsMemo?.[agent] ?? null);
  const [cfg, setCfg] = useState<AgentConfig | null>(() => modelsMemo?.config?.[agent] ?? null);
  const [perm, setPerm] = useState<Permission | null>(() => permMemo);
  const [err, setErr] = useState<ApiError | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [grant, setGrant] = useState<{ key: string; allowSend: boolean } | null>(null);
  const allowSend = grant && grant.key === sessionKey ? grant.allowSend : null;
  const readOnlyPreferences = props.mode === 'session' && allowSend !== true;
  const [modelRefresh, setModelRefresh] = useState(0);

  const load = useCallback(() => {
    // 没绑会话就没有 state 可读——模型和强度由调用方以 prop 给
    if (sessionKey) {
      api.state(sessionKey)
        .then((s) => { stateMemo.set(sessionKey, s); setState(s); })
        .catch(() => setState(null));
    }
    api.permission().then((p) => { permMemo = p; setPerm(p); }).catch(() => setPerm((prev) => prev));
  }, [sessionKey, agent]);

  useEffect(load, [load]);

  useEffect(() => {
    if (!sessionKey || !open) return;
    let current = true;
    api.health().then((h) => { if (current) setGrant({ key: sessionKey, allowSend: h.allowSend === true }); }).catch(() => {});
    return () => { current = false; };
  }, [sessionKey, open]);

  useEffect(() => {
    let current = true;
    api.models(modelRefresh > 0)
      .then((m) => { if (current) { modelsMemo = m; setModels(m[agent] ?? []); setCfg(m.config?.[agent] ?? null); } })
      .catch(() => { if (current) setModels((prev) => prev ?? []); });
    return () => { current = false; };
  }, [agent, modelRefresh]);

  // 在这里改了模型、强度之后，缓存里那份跟着变，免得回来时先闪一下旧的
  useEffect(() => {
    if (sessionKey && state) stateMemo.set(sessionKey, state);
  }, [sessionKey, state]);

  // 当前值的来源随模式而变，后面所有逻辑只认这两个变量
  const model = props.mode === 'session' ? state?.model ?? null : props.model;
  const effort = props.mode === 'session' ? state?.effort ?? null : props.effort;

  const chosen = models?.find((m) => m.id === model) ?? null;
  // 强度只看**所选模型**支持哪几档。没选模型时看不出来，退回列表里第一个有强度的
  // 那个模型的档位集——总比整组消失好，而 codex 各模型的档位集实测是一致的
  /**
   * 这个模型能选哪几档强度。**照手机端 `SetupPill` 的那段来，逐行对齐。**
   *
   * 目录给了就用目录的（逐模型不同）；给不出来就退回 `claude --help` 里那五档。
   *
   * ## 我在这里错过一次
   *
   * 上一版写的是 `?? []`，于是 Claude 那一组整个不出现，注释还断言「claude 各模型
   * 都不支持强度」。**那句话是错的**——`claude --help` 写着
   * `--effort <low|medium|high|xhigh|max>`，`args.js` 的 `effortFlags` 也一直在拼它。
   * `/api/models` 给 claude 的 `efforts` 是空数组，只是因为 Claude 侧**没有目录
   * 可查**（Codex 有 `codex debug models`），不是「它没有」。
   *
   * 是 owner 说「手机端里面有思考强度啊」才发现的——而手机端正是这么退的。
   * 同一个坑 `args.js` 抬头也记着一次：把「我没查到」写成「它没有」。
   *
   * 2026-11-10 起 Claude 侧也有目录了（Claude Code 自己 `/model` 用的那份），
   * 目录里的模型带 `listed: true`，强度表逐模型给。五档的退路只剩「目录拿不到」时用。
   */
  const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
  // agent 自己的目录列着的模型（`listed`），强度表就是权威的：Opus 4.6 没有 xhigh，
  // Haiku 4.5 一档都没有——空表在这里是「不能调」，不是「不知道」，不能退回五档
  const efforts = chosen?.listed || chosen?.efforts?.length
    ? chosen.efforts
    : (agent === 'claude' || agent === 'antigravity')
      ? CLAUDE_EFFORTS
      // Codex 但还没选具体模型：取所有候选的并集，至少不会漏掉能用的
      : [...new Set((models ?? []).flatMap((m) => m.efforts))];
  /**
   * 「默认」现在实际是什么——owner：「默认模型也要显示到底是什么模型以及推理强度」。
   * 照手机端 `SetupPill` 那段来：没选模型时看默认模型自己拿到的强度（Claude 的
   * 默认强度按模型定）；选了模型时只有配置里写死的那档对它也成立，其次是目录给的。
   */
  const dm = cfg?.defaultModel ?? null;
  const defaultEffort = model
    ? cfg?.effort ?? chosen?.defaultEffort ?? null
    : dm?.effort ?? cfg?.effort ?? null;
  const dmLabel = dm ? `${dm.name}${dm.contextWindow ? ` · ${ctxLabel(dm.contextWindow)}` : ''}` : null;

  const mode = perm?.agents?.[agent]?.mode ?? null;
  const modeLabel = perm?.agents?.[agent]?.options.find((o) => o.id === mode)?.label ?? mode;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  const pickModel = (id: string | null) => {
    if (props.mode === 'draft') {
      props.onModel(id);
      return;
    }
    run(async () => {
      const r = await api.setModel(props.sessionKey, id);
      setState((p) => (p ? { ...p, model: r.model } : p));
      // 正在跑的那一轮用的是老模型——后端明说了，别让人以为当前回答来自新模型
      if (r.note) setNote(r.note);
    });
  };

  const pickEffort = (e: string | null) => {
    if (props.mode === 'draft') {
      props.onEffort(e);
      return;
    }
    run(async () => {
      const r = await api.setEffort(props.sessionKey, e);
      setState((p) => (p ? { ...p, effort: r.effort } : p));
      if (running) setNote('当前这轮仍用原强度，下一条消息起生效。');
    });
  };

  const pickMode = (id: string) =>
    run(async () => setPerm(await api.setPermission(agent, id)));

  return (
    <div className="cfg">
      <button
        type="button"
        className={`cfg-bar${open ? ' is-open' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { setGrant(null); setOpen(true); setModelRefresh((revision) => revision + 1); }}
      >
        <span className="cfg-agent">{agent}</span>
        {/* null = 没选过。「没选过」与「选了正好等于默认」要显示得不一样：
            前者写「默认 · 它现在是谁」，后者只写名字 */}
        <span className="cfg-item">
          {chosen ? modelLabel(chosen) : model || (dmLabel ? `默认 · ${dmLabel}` : '默认模型')}
        </span>
        {effort
          ? <span className="cfg-item">{effortLabel(effort)}</span>
          : defaultEffort && <span className="cfg-item">{`默认 · ${effortLabel(defaultEffort)}`}</span>}
        {modeLabel && <span className={`cfg-item${mode === 'bypass' ? ' is-danger' : ''}`}>{modeLabel}</span>}
        <span className="chev" aria-hidden="true" />
      </button>

      {open && (
        <Modal
          title="会话配置"
          hint={props.mode === 'draft'
            ? '还没建会话：模型和强度在发出第一条消息时一并带上'
            : `这个 ${agent} 会话用什么模型、想多深、能做什么`}
          className="cfg-dlg"
          onClose={() => setOpen(false)}
          footer={(
            <>
              {/* 点一下就生效，没有「保存」——这个按钮只是关掉。写明这一点，
                  免得人以为不点它刚才的选择就不算数 */}
              {(!readOnlyPreferences || perm?.canSet) && <span className="cfg-foot-note">点一下就生效</span>}
              <button type="button" className="dlg-ok" onClick={() => setOpen(false)}>完成</button>
            </>
          )}
        >
          {/* 提示和报错放最上面：两栏铺开之后，放在底部的一行很容易在右栏下面被漏看 */}
          {note && <p className="cfg-note">{note}</p>}
          {err && (
            <p className="cfg-err" role="alert">
              <span>{err.message}</span>
              <span className="dim">{err.fix}</span>
            </p>
          )}

          {/* 宽屏两栏：左边「用什么」（agent、模型），右边「怎么跑」（强度、权限）。
              窄屏叠成一栏，顺序不变 */}
          <div className="cfg-cols">
            <div className="cfg-col">
              {/* agent 只在还没建会话时能选。会话已经建在某个 agent 上了，换不了——
                  手机 app 的 SetupPill 用 onAgent 是否传入表达同一件事 */}
              {props.mode === 'draft' && (
                <Group title="Agent">
                  {(['claude', 'codex', 'antigravity'] as const).map((a) => (
                    <Row
                      key={a}
                      on={agent === a}
                      onPick={() => props.onAgent(a)}
                      busy={busy}
                      label={a === 'claude' ? 'Claude' : a === 'antigravity' ? 'Antigravity' : 'Codex'}
                    />
                  ))}
                </Group>
              )}

              <Group
                title="模型"
                hint={props.mode === 'draft' ? '建会话时一并带上' : allowSend === false ? '当前身份只能查看模型和思考强度' : '落在这个会话上，两台设备看到同一个选择'}
              >
                <Row
                  on={!model}
                  onPick={() => pickModel(null)}
                  busy={busy || readOnlyPreferences}
                  label={`用 ${agent} 自己的默认`}
                  desc={dmLabel
                    ? `现在是 ${dmLabel}${dm?.effort ? ` · ${effortLabel(dm.effort)}` : ''}`
                    : undefined}
                />
                <ModelRows models={models} current={model} busy={busy || readOnlyPreferences} onPick={pickModel} />
              </Group>
            </div>

            <div className="cfg-col">
              {/* claude 各模型都不支持强度，整组不出现——给一组永远无效的选项更糟 */}
              {efforts.length > 0 && (
                <Group title="思考强度" hint={props.mode === 'draft' ? '和模型一样，建会话时一并带上' : '跟模型一样落在这个会话上'}>
                  <Row
                    on={!effort}
                    onPick={() => pickEffort(null)}
                    busy={busy || readOnlyPreferences}
                    label="跟模型默认走"
                    desc={defaultEffort ? `现在是 ${effortLabel(defaultEffort)}` : undefined}
                  />
                  {efforts.map((e) => (
                    <Row
                      key={e}
                      on={effort === e}
                      onPick={() => pickEffort(e)}
                      busy={busy || readOnlyPreferences}
                      label={effortLabel(e)}
                    />
                  ))}
                </Group>
              )}

              <Group
                title="权限档位"
                hint={
                  perm?.canSet === false
                    ? '只有这台电脑的主人能改'
                    : `影响这台电脑上所有 ${agent} 会话的下一轮，不只是这一条`
                }
              >
                {perm?.agents?.[agent]?.options.map((o) => (
                  <Row
                    key={o.id}
                    on={o.id === mode}
                    onPick={() => pickMode(o.id)}
                    busy={busy}
                    disabled={!o.available || perm.canSet === false}
                    label={o.label}
                    desc={o.unavailable ?? o.body}
                    danger={o.danger}
                    blocked={!o.available}
                  />
                ))}
                {!perm && <p className="cfg-hint">正在读…</p>}
              </Group>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

/**
 * `hidden: true` 是供应商目录里标了不常用的。默认收起来——实测 codex 有 7 个模型，
 * 全铺开会让「我常用那两个」淹掉。
 */
function ModelRows({
  models, current, busy, onPick,
}: {
  models: ModelOption[] | null;
  current: string | null;
  busy: boolean;
  onPick: (id: string) => void;
}) {
  const [all, setAll] = useState(false);
  if (!models) return <p className="cfg-hint">正在读…</p>;
  if (models.length === 0) return <p className="cfg-hint">这台电脑上没扫到可选模型。</p>;

  // 收起来的那些里如果正好有当前选中的，就必须展开——否则面板显示「什么都没选」
  const hiddenHasCurrent = models.some((m) => m.hidden && m.id === current);
  const show = all || hiddenHasCurrent ? models : models.filter((m) => !m.hidden);
  const rest = models.length - show.length;

  return (
    <>
      {show.map((m) => (
        <Row
          key={m.id}
          on={m.id === current}
          onPick={() => onPick(m.id)}
          busy={busy}
          label={modelLabel(m)}
          // 不标「没在这台电脑上跑过」：手机端早先这么标过，owner 否掉了——那预设了
          // 「用户的配置可能不对」，而配置对不对不归我们判断（app/src/api/types.ts 的 seen）。
          // 何况现在 Claude 的表就是 Claude Code 自己 /model 的目录，13 个里没跑过的占大半
          desc={m.desc ?? undefined}
        />
      ))}
      {rest > 0 && (
        <button type="button" className="cfg-more" onClick={() => setAll(true)}>
          还有 {rest} 个不常用的
        </button>
      )}
    </>
  );
}

function Group({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="cfg-group">
      <h3 className="cfg-title">{title}</h3>
      {hint && <p className="cfg-hint">{hint}</p>}
      <div className="cfg-rows">{children}</div>
    </section>
  );
}

/** 分组列表 + 打勾，不是一排平铺的按钮——选中态在长列表里必须一眼看得见。 */
function Row({
  on, onPick, busy, label, desc, disabled, danger, blocked,
}: {
  on: boolean;
  onPick: () => void;
  busy: boolean;
  label: string;
  desc?: string;
  disabled?: boolean;
  danger?: boolean;
  blocked?: boolean;
}) {
  return (
    <button
      type="button"
      className={`cfg-row${on ? ' is-on' : ''}${danger ? ' is-danger' : ''}`}
      aria-pressed={on}
      disabled={disabled || busy}
      onClick={onPick}
    >
      <span className="cfg-tick" aria-hidden="true">{on ? '✓' : ''}</span>
      <span className="cfg-text">
        <span className="cfg-label">{label}</span>
        {desc && <span className={`cfg-desc${blocked ? ' is-blocked' : ''}`}>{desc}</span>}
      </span>
    </button>
  );
}
