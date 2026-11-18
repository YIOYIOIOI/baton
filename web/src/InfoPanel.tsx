import { useEffect, useRef, useState } from 'react';
import { api, type FileEdit, type FileStat, type SessionInfo } from './api';
import { dirTrail } from './sessions';
import { GOAL_STATE, fmtDuration, goalNeedsYou } from './goal';
import { useI18n } from './i18n';
import { Icon } from './Shell';
import './infopanel.css';

export function InfoPanel({
  sessionKey, info, err, onClose, onClearGoal, onGoalMode, running,
}: {
  sessionKey: string;
  info: SessionInfo | null;
  err: string | null;
  onClose: () => void;
  onClearGoal: () => void;
  onGoalMode: () => void;
  running: boolean;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState<string | null>(null);

  const plan = info?.plan ?? null;
  const done = plan ? plan.filter((x) => x.status === 'completed').length : 0;

  return (
    <aside className="info" aria-label={t('info.title')}>
      <div className="info-head">
        <span className="info-title">{t('info.title')}</span>
        <button type="button" className="info-x" onClick={onClose} aria-label={t('info.close')} title={t('info.close')}>
          <Icon name="panel" />
        </button>
      </div>

      <div className="info-body">
        {!info && !err && <p className="info-dim">{t('info.loading')}</p>}
        {err && <p className="info-dim">{err}</p>}

        {info && (
          <>
            <section className="info-sec">
              <h3>{t('info.goal')}</h3>
              {info.goal && !info.goal.met ? (
                <div className={`goalcard${goalNeedsYou(info.goal.status) ? ' is-warn' : ' is-live'}`}>
                  <div className="goalcard-top">
                    <Icon name="target" className="goalcard-ico" />
                    <span className="goalcard-state">
                      {info.goal.status && info.goal.status !== 'active'
                        ? GOAL_STATE[info.goal.status] ?? info.goal.status
                        : running || info.agent === 'codex' ? t('info.goalActive') : t('info.goalWaitTurn')}
                    </span>
                  </div>
                  <p className="goalcard-cond">{info.goal.condition}</p>
                  {info.goal.reason && <p className="goalcard-why">{info.goal.reason}</p>}
                  {(info.goal.tokensUsed ?? 0) > 0 && (
                    <p className="goalcard-why">
                      {fmtTokens(info.goal.tokensUsed ?? 0)} tokens{info.goal.tokenBudget ? ` / ${fmtTokens(info.goal.tokenBudget)}` : ''}
                      {(info.goal.timeUsedSeconds ?? 0) > 0 && ` · ${fmtDuration(info.goal.timeUsedSeconds ?? 0)}`}
                    </p>
                  )}
                  <button type="button" className="info-btn" onClick={onClearGoal}>{t('info.goalClear')}</button>
                </div>
              ) : (
                <>
                  {info.goal?.met && (
                    <div className="goalcard is-met">
                      <div className="goalcard-top">
                        <span className="goalcard-ok" aria-hidden="true">✓</span>
                        <span className="goalcard-state">{t('info.goalMet')}</span>
                      </div>
                      <p className="goalcard-cond">{info.goal.condition}</p>
                      {info.goal.reason && <p className="goalcard-why">{info.goal.reason}</p>}
                    </div>
                  )}
                  <button type="button" className="info-btn is-ghost" onClick={onGoalMode}>
                    <Icon name="target" /> {t('info.goalSet')}
                  </button>
                  <p className="info-hint">{t('info.goalHint')}</p>
                </>
              )}
            </section>

            {plan && plan.length > 0 && (
              <section className="info-sec">
                <h3>
                  {t('info.plan')} <span className="info-count">{done}/{plan.length}</span>
                </h3>
                <ol className="plan">
                  {plan.map((p, i) => (
                    <li key={i} className={`plan-item is-${p.status}`}>
                      <span className="plan-mark" aria-hidden="true">
                        {p.status === 'completed' ? '✓' : ''}
                      </span>
                      <span className="plan-text">{p.content}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            {info.recap && (
              <section className="info-sec">
                <h3>{t('info.recap')}</h3>
                <p className="info-recap">{info.recap.text}</p>
              </section>
            )}

            {info.context && (
              <section className="info-sec">
                <h3>{t('info.context')}</h3>
                <Context used={info.context.used} window={info.context.window} />
              </section>
            )}

            <section className="info-sec">
              <h3>{t('info.session')}</h3>
              <dl className="info-kv">
                <dt>Agent</dt><dd>{info.agent === 'claude' ? 'Claude Code' : info.agent === 'antigravity' ? 'Antigravity' : 'Codex'}</dd>
                {info.model && <><dt>{t('info.model')}</dt><dd>{info.model.name}</dd></>}
                <dt>{t('info.dir')}</dt><dd>{dirTrail(info.cwd)}</dd>
                {info.branch && <><dt>{t('info.branch')}</dt><dd className="mono">{info.branch}</dd></>}
              </dl>
              <a className="info-btn is-ghost" href={api.exportUrl(sessionKey)} download>
                {t('info.exportBtn')}
              </a>
            </section>

            <section className="info-sec">
              <h3>
                {t('info.files')} {info.fileCount > 0 && <span className="info-count">{info.fileCount}</span>}
              </h3>
              {!info.filesTracked ? (
                <p className="info-dim">{t('info.filesNoCodex')}</p>
              ) : info.files.length === 0 ? (
                <p className="info-dim">{t('info.filesEmpty')}</p>
              ) : (
                <ul className="files">
                  {info.files.map((f) => (
                    <FileRow
                      key={f.path}
                      f={f}
                      open={open === f.path}
                      onToggle={() => setOpen(open === f.path ? null : f.path)}
                      sessionKey={sessionKey}
                    />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function Context({ used, window }: { used: number; window: number | null }) {
  const pct = window ? Math.min(100, Math.round((used / window) * 100)) : null;
  return (
    <div className="ctx">
      {pct !== null && (
        <div className={`ctx-bar${pct >= 80 ? ' is-high' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      <p className="ctx-num">
        {fmtTokens(used)}
        {window ? ` / ${fmtTokens(window)}` : ''} tokens
        {pct !== null && <span className="info-dim"> · {pct}%</span>}
      </p>
    </div>
  );
}

/** 一个改过的文件。点开看这个会话里对它的每一次改动（改前 / 改后） */
function FileRow({ f, open, onToggle, sessionKey }: { f: FileStat; open: boolean; onToggle: () => void; sessionKey: string }) {
  const [edits, setEdits] = useState<FileEdit[] | null>(null);
  const loaded = useRef(false);
  useEffect(() => {
    if (!open || loaded.current) return;
    loaded.current = true;
    api.fileEdits(sessionKey, f.path).then((r) => setEdits(r.edits)).catch(() => setEdits([]));
  }, [open, sessionKey, f.path]);

  const slash = f.path.lastIndexOf('/');
  const name = f.path.slice(slash + 1);
  const dir = slash > 0 ? f.path.slice(0, slash) : '';
  return (
    <li className={`file${open ? ' is-open' : ''}`}>
      <button type="button" className="file-row" onClick={onToggle} aria-expanded={open} title={f.path}>
        <span className="file-name">
          {name}
          {dir && <span className="file-dir">{dir}</span>}
        </span>
        <span className="file-diff">
          {f.added > 0 && <span className="add">+{f.added}</span>}
          {f.removed > 0 && <span className="del">−{f.removed}</span>}
        </span>
      </button>
      {open && (
        <div className="file-edits">
          {edits === null && <p className="info-dim">正在读…</p>}
          {edits?.length === 0 && <p className="info-dim">没找到这个文件的改动记录。</p>}
          {edits?.map((e, i) => (
            <pre key={i} className="diff">
              {e.kind === 'write' && <span className="diff-note">整个文件写入</span>}
              {e.before && e.before.split('\n').map((l, j) => <span key={`b${j}`} className="diff-del">{`- ${l}`}</span>)}
              {e.after.split('\n').map((l, j) => <span key={`a${j}`} className="diff-add">{`+ ${l}`}</span>)}
            </pre>
          ))}
        </div>
      )}
    </li>
  );
}

/**
 * 会话信息（服务端 src/sessioninfo.js）。`version` 一变就重新取——会话页在新事件进来、一轮开始或
 * 结束时让它变。服务端是增量读的，重新取很便宜；这里再压一下，0.8 秒内的多次变化只取一次。
 * 头一次不等。
 */
export function useSessionInfo(sessionKey: string, version: number): { info: SessionInfo | null; err: string | null } {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const first = useRef(true);
  useEffect(() => {
    let alive = true;
    const wait = first.current ? 0 : 800;
    first.current = false;
    const t = setTimeout(() => {
      api.info(sessionKey)
        .then((r) => { if (alive) { setInfo(r); setErr(null); } })
        .catch((e: { message?: string }) => { if (alive) setErr(e.message ?? '读不出来'); });
    }, wait);
    return () => { alive = false; clearTimeout(t); };
  }, [sessionKey, version]);
  return { info, err };
}
