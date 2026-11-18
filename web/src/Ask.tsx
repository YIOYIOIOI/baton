import { useEffect, useMemo, useState } from 'react';
import { api, type ApiError, type PendingAsk } from './api';
import { useI18n } from './i18n';
import './ask.css';

/**
 * agent 出的选择题。
 *
 * ## 这张卡和别的提示不是一回事
 *
 * 它挂着的时候，**agent 那一轮正停在工具调用上等它**（实测：MCP 工具调用会
 * 阻塞整轮，睡 75 秒那一轮就跑了 81 秒）。所以它不是一条可以划走的通知——
 * 不答就是一轮白等 4 分钟。因此：
 *
 *   · 钉在输入框正上方，不随对话滚走
 *   · 有倒计时。不是装饰：它说明「再不答这一轮就废了」
 *   · 选项是整行的大按钮，手机上一只手能点
 *
 * ## 为什么还要留一个「自己写」
 *
 * 实测 Claude 那个 AskUserQuestion 的 165 条真实结果里，用户**经常不选给定项**，
 * 而是写一段话（「索道如果是下午的话可以去坐，然后我想说…」）。只给按钮等于
 * 逼人把话说错，而说错的代价是 agent 照着错的往下做。
 */

const MIN_TOUCH = 44; // WCAG 2.5.5 AAA；CSS 里同一个数，这里只是说明来源

function useCountdown(expiresAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);
  if (!expiresAt) return 0;
  return Math.max(0, Math.round((expiresAt - now) / 1000));
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function AskCard({ ask, sessionKey, onDone }: {
  ask: PendingAsk;
  sessionKey: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [picked, setPicked] = useState<string[]>([]);
  const [free, setFree] = useState('');
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const left = useCountdown(ask.expiresAt);

  /*
    换了一道题要把上一道的选择清掉，否则上一题勾过的会跟着过来。
    **靠调用处的 `key={ask.askId}` 让 React 整个重建这张卡**，不在 effect 里
    逐个 setState——后者是官方文档点名的反模式，而且每加一个 state 就要记得
    在那儿补一行，迟早漏。
  */

  const canSend = useMemo(
    () => (picked.length > 0 || free.trim().length > 0) && !busy,
    [picked, free, busy],
  );

  async function submit(one?: string) {
    if (busy) return;
    const body = one ? { picked: [one], free: null } : { picked, free: free.trim() || null };
    if (!body.picked.length && !body.free) return;
    setBusy(true);
    setErr(null);
    try {
      await api.answer(sessionKey, { askId: ask.askId, ...body });
      onDone();
    } catch (e) {
      const ae = e as ApiError;
      setErr(ae.fix ? `${ae.message} ${ae.fix}` : ae.message);
      // 已经不在等了（超时/这一轮被停），卡片留着没有意义
      if (ae.status === 409) onDone();
    } finally {
      setBusy(false);
    }
  }

  function toggle(label: string) {
    // 单选题点一下就直接答掉：多一步「确定」在手机上纯属多余，
    // 而这一步正卡着 agent 的一轮
    if (!ask.multiSelect) {
      void submit(label);
      return;
    }
    setPicked((prev) => (prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]));
  }

  return (
    <section className="ask" aria-label={t('ask.aria')}>
      <header className="ask-head">
        <span className="ask-chip">{ask.header || t('ask.chip')}</span>
        <span className="ask-left">
          {left > 0 ? fmt(left) : t('ask.timeout')}
        </span>
      </header>

      <p className="ask-q">{ask.question}</p>

      <div className="ask-opts" role={ask.multiSelect ? 'group' : 'radiogroup'}>
        {ask.options.map((o) => {
          const on = picked.includes(o.label);
          return (
            <button
              key={o.label}
              type="button"
              role={ask.multiSelect ? 'checkbox' : 'radio'}
              aria-checked={on}
              className={`ask-opt${on ? ' on' : ''}`}
              style={{ minHeight: MIN_TOUCH }}
              onClick={() => toggle(o.label)}
              disabled={busy}
            >
              <span className="ask-opt-label">{o.label}</span>
              {o.description && <span className="ask-opt-desc">{o.description}</span>}
            </button>
          );
        })}
      </div>

      {writing ? (
        <div className="ask-free">
          <textarea
            value={free}
            onChange={(e) => setFree(e.target.value)}
            placeholder={t('ask.customPlaceholder')}
            rows={3}
            autoFocus
          />
        </div>
      ) : (
        <button type="button" className="ask-write" onClick={() => setWriting(true)}>
          {t('ask.customBtn')}
        </button>
      )}

      {/* 单选且没在写字时，点选项即提交，这一行就不出现——少一个没用的按钮 */}
      {(ask.multiSelect || writing) && (
        <button type="button" className="ask-send" onClick={() => submit()} disabled={!canSend}>
          {busy ? t('ask.sending') : t('ask.send')}
        </button>
      )}

      {err && <p className="ask-err" role="alert">{err}</p>}
    </section>
  );
}
