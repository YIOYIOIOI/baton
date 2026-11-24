import { Handoff } from './Handoff';
import { useI18n } from './i18n';
import { setPrefs } from './prefs';
import { Session } from './Session';
import { Wordmark } from './Wordmark';
import './door.css';
import './welcome.css';

export function Welcome({ pending = false }: { pending?: boolean }) {
  const { locale, t } = useI18n();
  const nextLocale = locale === 'zh' ? 'en' : 'zh';

  return (
    <div className="door door-welcome">
      <button
        type="button"
        className="door-lang"
        onClick={() => setPrefs({ locale: nextLocale })}
        aria-label={t('lang.toggleLabel')}
      >
        {locale === 'zh' ? 'EN' : '中文'}
      </button>

      <div className="door-art" aria-hidden="true">
        <Handoff className="is-float" />
      </div>

      <header className="door-top">
        <a className="door-brand" href="/welcome">
          <Wordmark />
        </a>
      </header>

      <main className="door-main">
        <div className="door-body">
          {/* 宽屏上字标在这里，不在右栏顶上——那个角会被插画的手臂盖住（door.css） */}
          <a className="door-brand-inline" href="/welcome" aria-hidden="true" tabIndex={-1}>
            <Wordmark />
          </a>
          <div className="hero-say">
            <h1 className="display">
              {t('welcome.displayLine1')}
              <br />
              {t('welcome.displayLine2')}
            </h1>
            {/* 写成一个表达式：JSX 的换行会在句末留一个空格 */}
            <p className="lead">{t('welcome.lead')}</p>
            <div className="cta-row">
              {pending ? <p role="status">{t('pair.unpairPending')}</p> : <a className="cta" href="/pair">
                {t('welcome.cta')}
              </a>}
              <p className="note">{t('welcome.note')}</p>
            </div>
          </div>

          <div className="hero-show">
            <Session />
          </div>
        </div>
      </main>
    </div>
  );
}
