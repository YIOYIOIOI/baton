import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type AgentUsage, type Usage, type UsageWindow } from './api';
import { useI18n, type MsgKey } from './i18n';
import { Modal } from './Modal';
import './usage.css';

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', plus: 'Plus', team: 'Team', enterprise: 'Enterprise', free: 'Free' };

function resetLabel(ms: number | null, now: number, t: (k: MsgKey, v?: Record<string, string | number>) => string, locale: 'en' | 'zh'): string | null {
  if (!ms) return null;
  const d = ms - now;
  if (d <= 0) return t('usage.resetDone');
  const min = Math.round(d / 60_000);
  if (min < 60) return t('usage.resetInMin', { m: min });
  const h = Math.floor(min / 60);
  if (h < 24) return t('usage.resetInHour', { h, m: min % 60 });
  const tm = new Date(ms);
  const hm = `${String(tm.getHours()).padStart(2, '0')}:${String(tm.getMinutes()).padStart(2, '0')}`;
  if (h < 48) return t('usage.resetTomorrow', { hm });
  const dayStr = tm.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
  return t('usage.resetLater', { d: dayStr, hm });
}

function agoLabel(ms: number | null, now: number, locale: 'en' | 'zh'): string | null {
  if (!ms) return null;
  const min = Math.round((now - ms) / 60_000);
  if (min < 1) return locale === 'zh' ? '刚刚' : 'just now';
  if (min < 60) return locale === 'zh' ? `${min} 分钟前` : `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 48) return locale === 'zh' ? `${h} 小时前` : `${h}h ago`;
  return locale === 'zh' ? `${Math.round(h / 24)} 天前` : `${Math.round(h / 24)}d ago`;
}

/** 条的颜色按剩余：三成以上是球色，一成到三成是警示色，一成以下是危险色 */
function level(left: number): string {
  if (left <= 10) return ' is-high';
  if (left <= 30) return ' is-mid';
  return '';
}

function Window({ w, now }: { w: UsageWindow; now: number }) {
  const { locale, t } = useI18n();
  const left = Math.max(0, Math.min(100, Math.round(100 - w.percent)));
  return (
    <div className="use-win">
      <div className="use-win-top">
        <span className="use-win-label">{w.label}</span>
        <span className={`use-win-pct${level(left)}`}>
          <span className="use-win-pct-k">{t('usage.remaining')}</span> {left}%
        </span>
      </div>
      <div
        className="use-bar"
        role="progressbar"
        aria-label={`${w.label} ${t('usage.remaining')}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={left}
      >
        <span className={`use-bar-fill${level(left)}`} style={{ width: `${left === 0 ? 0 : Math.max(left, 1.5)}%` }} />
      </div>
      <span className="use-win-reset">{resetLabel(w.resetsAt, now, t, locale) ?? t('usage.resetUnknown')}</span>
    </div>
  );
}

function AgentCard({ name, u, now }: { name: string; u: AgentUsage; now: number }) {
  const { locale, t } = useI18n();
  const plan = u.plan ? PLAN[u.plan] ?? u.plan : null;
  const stale = u.available && u.source === 'rollout';
  const agoStr = u.available && u.asOf ? (agoLabel(u.asOf, now, locale) ?? '') : '';
  return (
    <section className="use-card">
      <header className="use-card-head">
        <span className="use-card-name">{name}</span>
        {plan && <span className="use-plan">{plan}</span>}
        {u.available && u.asOf && (
          <span className={`use-asof${stale ? ' is-stale' : ''}`}>
            {stale ? t('usage.stale', { ago: agoStr }) : t('usage.updated', { ago: agoStr })}
          </span>
        )}
      </header>
      {u.available ? (
        u.windows.length ? (
          <div className="use-wins">
            {u.windows.map((w) => <Window key={w.id} w={w} now={now} />)}
          </div>
        ) : (
          <p className="use-note">{t('usage.noWindows')}</p>
        )
      ) : (
        <p className="use-note">{u.reason}</p>
      )}
      {u.available && u.extraUsage && <p className="use-note">{t('usage.extra')}</p>}
    </section>
  );
}

export function UsagePanel() {
  const { t } = useI18n();
  const [data, setData] = useState<Usage | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback((refresh: boolean) => {
    setBusy(true);
    api
      .usage(refresh)
      .then((d) => {
        setData(d);
        setErr(null);
        setNow(Date.now());
      })
      .catch((e: ApiError) => setErr(e))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    api
      .usage(false)
      .then((d) => {
        setData(d);
        setNow(Date.now());
      })
      .catch((e: ApiError) => setErr(e))
      .finally(() => setBusy(false));
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="use">
      {err && (
        <p className="use-err" role="alert">
          <span>{err.message}</span>
          <span className="dim">{err.fix}</span>
        </p>
      )}
      {!data && !err && <p className="use-note">{t('usage.loading')}</p>}
      {data && (
        <div className="use-cards">
          <AgentCard name="Claude" u={data.claude} now={now} />
          <AgentCard name="Codex" u={data.codex} now={now} />
          {data.antigravity && <AgentCard name="Antigravity" u={data.antigravity} now={now} />}
        </div>
      )}
      <div className="use-foot">
        <span className="use-hint">{t('usage.hint')}</span>
        <button type="button" className="use-refresh" onClick={() => load(true)} disabled={busy}>
          {busy ? t('usage.refreshing') : t('usage.refresh')}
        </button>
      </div>
    </div>
  );
}

export function UsageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Modal title={t('usage.title')} hint={t('usage.subtitle')} className="use-dlg" onClose={onClose}>
      <UsagePanel />
    </Modal>
  );
}
