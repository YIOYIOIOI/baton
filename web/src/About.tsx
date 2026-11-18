import { useEffect, useState } from 'react';
import { ApiError, api, type DeviceItem, type PairQrResult } from './api';
import { useI18n } from './i18n';
import { SHORTCUTS } from './Palette';
import { setPrefs, usePrefs, type ListMode, type LocalePref, type Size, type Theme, type Width } from './prefs';
import { ago } from './sessions';
import { copyText, keyLabel, openShortcuts } from './ui';
import { UsagePanel } from './Usage';
import './new.css';
import './settings.css';

function Choice<T extends string>({
  value, onChange, options, label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { id: T; label: string; note?: string }[];
  label: string;
}) {
  return (
    <div className="set-choice" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`set-opt${value === o.id ? ' is-on' : ''}`}
          onClick={() => onChange(o.id)}
        >
          <span className="set-opt-label">{o.label}</span>
          {o.note && <span className="set-opt-note">{o.note}</span>}
        </button>
      ))}
    </div>
  );
}

export function About() {
  const prefs = usePrefs();
  const { t, locale } = useI18n();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [allowSend, setAllowSend] = useState<boolean | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState<boolean>(true);
  const [devices, setDevices] = useState<DeviceItem[] | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [qr, setQr] = useState<PairQrResult | null>(null);
  const [qrBusy, setQrBusy] = useState(false);
  const [at, setAt] = useState<string>('look');
  const [now] = useState(() => Date.now());

  const sections = [
    { id: 'look', label: t('about.secLook') },
    ...(isOwner ? [{ id: 'usage', label: t('about.secUsage') }] : []),
    { id: 'keys', label: t('about.secKeys') },
    { id: 'conn', label: t('about.secConn') },
    { id: 'about', label: t('about.secAbout') },
  ];

  useEffect(() => {
    api.health()
      .then((h) => {
        setAllowSend(h.allowSend === true);
        setVersion(h.version ?? null);
        if (h.principal) setIsOwner(h.principal.isOwner);
      })
      .catch(() => setAllowSend(null));
    api.devices()
      .then((r) => setDevices(r.devices))
      .catch(() => setDevices([]));
  }, []);

  useEffect(() => {
    const box = document.querySelector<HTMLElement>('.set');
    if (!box) return;
    const onScroll = () => {
      if (box.scrollTop + box.clientHeight >= box.scrollHeight - 4) {
        setAt(sections[sections.length - 1].id);
        return;
      }
      const edge = box.getBoundingClientRect().top + 120;
      let cur: string = sections[0].id;
      for (const s of sections) {
        const el = document.getElementById(`set-${s.id}`);
        if (el && el.getBoundingClientRect().top <= edge) cur = s.id;
      }
      setAt(cur);
    };
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  });

  async function unpair() {
    setBusy(true);
    setErr(null);
    try {
      await api.unpair();
      window.location.href = '/welcome';
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setRevokingId(id);
    setErr(null);
    try {
      const res = await api.revokeDevice(id);
      if (res.self) {
        window.location.href = '/welcome';
        return;
      }
      setDevices((prev) => (prev ? prev.filter((d) => d.id !== id) : prev));
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setRevokingId(null);
    }
  }

  async function generateQr() {
    setQrBusy(true);
    setErr(null);
    try {
      setQr(await api.mintPairQr());
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setQrBusy(false);
    }
  }

  const jump = (id: string) => {
    setAt(id);
    document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="set">
      <div className="set-inner">
        <h1 className="set-title">{t('about.title')}</h1>

        <div className="set-cols">
          <nav className="set-nav" aria-label={t('about.title')}>
            {sections.map((s) => (
              <button
                key={s.id}
                type="button"
                className={`set-nav-item${at === s.id ? ' is-on' : ''}`}
                onClick={() => jump(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="set-body">
            <section className="set-sec" id="set-look">
              <h2 className="set-h">{t('about.secLook')}</h2>
              <p className="set-p">{t('about.lookDesc')}</p>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.language')}</span>
                  <span className="set-row-note">{t('about.languageNote')}</span>
                </div>
                <Choice<LocalePref>
                  label={t('about.language')}
                  value={prefs.locale}
                  onChange={(locale) => setPrefs({ locale })}
                  options={[
                    { id: 'auto', label: t('lang.auto') },
                    { id: 'en', label: t('lang.en') },
                    { id: 'zh', label: t('lang.zh') },
                  ]}
                />
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.theme')}</span>
                  <span className="set-row-note">{t('about.themeNote')}</span>
                </div>
                <Choice<Theme>
                  label={t('about.theme')}
                  value={prefs.theme}
                  onChange={(theme) => setPrefs({ theme })}
                  options={[
                    { id: 'system', label: t('shell.themeSystem') },
                    { id: 'light', label: t('shell.themeLight') },
                    { id: 'dark', label: t('shell.themeDark') },
                  ]}
                />
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.size')}</span>
                  <span className="set-row-note">{t('about.sizeNote')}</span>
                </div>
                <Choice<Size>
                  label={t('about.size')}
                  value={prefs.size}
                  onChange={(size) => setPrefs({ size })}
                  options={[
                    { id: 'sm', label: t('about.sizeSm') },
                    { id: 'md', label: t('about.sizeMd') },
                    { id: 'lg', label: t('about.sizeLg') },
                  ]}
                />
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.width')}</span>
                  <span className="set-row-note">{t('about.widthNote')}</span>
                </div>
                <Choice<Width>
                  label={t('about.width')}
                  value={prefs.width}
                  onChange={(width) => setPrefs({ width })}
                  options={[
                    { id: 'normal', label: t('about.widthNormal') },
                    { id: 'wide', label: t('about.widthWide') },
                  ]}
                />
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.listMode')}</span>
                  <span className="set-row-note">{t('about.listModeNote')}</span>
                </div>
                <Choice<ListMode>
                  label={t('about.listMode')}
                  value={prefs.listMode}
                  onChange={(listMode) => setPrefs({ listMode })}
                  options={[
                    { id: 'folders', label: t('about.listFolders') },
                    { id: 'recent', label: t('about.listRecent') },
                  ]}
                />
              </div>

              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.archivedLabel')}</span>
                  <span className="set-row-note">{t('about.archivedNote')}</span>
                </div>
                <Choice<'show' | 'hide'>
                  label={t('about.archivedLabel')}
                  value={prefs.showArchived ? 'show' : 'hide'}
                  onChange={(v) => setPrefs({ showArchived: v === 'show' })}
                  options={[
                    { id: 'hide', label: t('about.archivedHide') },
                    { id: 'show', label: t('about.archivedShow') },
                  ]}
                />
              </div>

              {prefs.pinned.length > 0 && (
                <div className="set-row">
                  <div className="set-row-text">
                    <span className="set-row-label">{t('about.pinned')}</span>
                    <span className="set-row-note">{t('about.pinnedCount', { n: prefs.pinned.length })}</span>
                  </div>
                  <button type="button" className="set-btn" onClick={() => setPrefs({ pinned: [] })}>
                    {t('about.unpinAll')}
                  </button>
                </div>
              )}
            </section>

            {isOwner && (
              <section className="set-sec" id="set-usage">
                <h2 className="set-h">{t('about.secUsage')}</h2>
                <p className="set-p">{t('about.usageDesc')}</p>
                <div className="set-usage">
                  <UsagePanel />
                </div>
              </section>
            )}

            <section className="set-sec" id="set-keys">
              <h2 className="set-h">{t('about.secKeys')}</h2>
              <p className="set-p">{t('about.keysDesc')}</p>
              <div className="set-keys">
                {SHORTCUTS.map((s) => (
                  <div key={s.combo} className="set-key">
                    <span>{t(s.labelKey)}</span>
                    <kbd>{keyLabel(s.combo)}</kbd>
                  </div>
                ))}
              </div>
              <button type="button" className="set-btn" onClick={openShortcuts}>{t('about.openKeys')}</button>
            </section>

            <section className="set-sec" id="set-conn">
              <h2 className="set-h">{t('about.secConn')}</h2>
              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.hostLabel')}</span>
                  <span className="set-row-note">{t('about.hostNote')}</span>
                </div>
                <code className="set-code">{window.location.host}</code>
              </div>
              {version && (
                <div className="set-row">
                  <div className="set-row-text">
                    <span className="set-row-label">{t('about.versionLabel')}</span>
                  </div>
                  <code className="set-code">v{version}</code>
                </div>
              )}
              <div className="set-row">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.sendLabel')}</span>
                  <span className="set-row-note">{t('about.sendNote')}</span>
                </div>
                <span className={`set-state${allowSend === false ? ' is-off' : ''}`}>
                  {allowSend === null ? t('about.sendRead') : allowSend ? t('about.sendOn') : t('about.sendOff')}
                </span>
              </div>

              <div className="set-devices">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.devicesTitle')}</span>
                  <span className="set-row-note">{t('about.devicesNote')}</span>
                </div>
                {devices === null && <p className="set-p">{t('about.devicesLoading')}</p>}
                {devices?.length === 0 && <p className="set-p">{t('about.devicesEmpty')}</p>}
                {devices?.map((d) => (
                  <div key={d.id} className="set-dev-row">
                    <div className="set-dev-meta">
                      <span className="set-dev-name">
                        {d.label}
                        {d.current && <span className="set-dev-badge">{t('about.deviceCurrent')}</span>}
                      </span>
                      <span className="set-dev-sub">
                        {d.principalId} · {d.platform} · {ago(d.lastSeenAt, now, locale)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="set-btn"
                      onClick={() => void revoke(d.id)}
                      disabled={revokingId === d.id}
                    >
                      {revokingId === d.id ? t('about.deviceRevoking') : t('about.deviceRevoke')}
                    </button>
                  </div>
                ))}
              </div>

              {isOwner && (
                <div className="set-qr-box">
                  <div className="set-row">
                    <div className="set-row-text">
                      <span className="set-row-label">{t('about.qrTitle')}</span>
                      <span className="set-row-note">{t('about.qrNote')}</span>
                    </div>
                    <button type="button" className="set-btn" onClick={() => void generateQr()} disabled={qrBusy}>
                      {qrBusy ? t('about.qrGenerating') : t('about.qrGenerate')}
                    </button>
                  </div>
                  {qr && (
                    <div className="set-qr-card">
                      <img
                        className="set-qr-img"
                        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}`}
                        alt={t('about.qrAlt')}
                      />
                      <div className="set-qr-info">
                        <code className="set-code">{qr.code}</code>
                        <p className="set-p">{t('about.qrExpires')}</p>
                        <div className="set-qr-actions">
                          <button type="button" className="set-btn" onClick={() => copyText(qr.code, t('about.qrCopyCode'))}>
                            {t('about.qrCopyCode')}
                          </button>
                          {qr.pairUrl && (
                            <button type="button" className="set-btn" onClick={() => copyText(qr.pairUrl as string, t('about.qrCopyUrl'))}>
                              {t('about.qrCopyUrl')}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="set-danger">
                <div className="set-row-text">
                  <span className="set-row-label">{t('about.unpairTitle')}</span>
                  <span className="set-row-note">{t('about.unpairNote')}</span>
                </div>
                <button className="about-danger" type="button" onClick={unpair} disabled={busy}>
                  {busy ? t('about.unpairBusy') : t('about.unpairBtn')}
                </button>
              </div>
              {err && (
                <p className="newp-err" role="alert">
                  <span>{err.message}</span>
                  <span className="dim">{err.fix}</span>
                </p>
              )}
            </section>

            <section className="set-sec" id="set-about">
              <h2 className="set-h">{t('about.secAbout')}</h2>
              <p className="set-p">{t('about.p1')}</p>
              <p className="set-p">{t('about.p2')}</p>
              <p className="set-disclaimer">{t('about.disclaimer')}</p>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
