import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api, CODE_ALPHABET, CODE_LENGTH } from './api';
import { Handoff } from './Handoff';
import { useI18n } from './i18n';
import { setPrefs } from './prefs';
import { Wordmark } from './Wordmark';
import { Toasts, copyText } from './ui';
import './door.css';
import './pair.css';

/**
 * 配对页。
 *
 * 这是浏览器端唯一一道门，所以它只做一件事：**把那 12 个字符收对**。
 *
 * ## 2026-11-06 重做
 *
 * owner 换域名后在家里的电脑上重新配对，报了「配对界面有 bug」，并要「更高级的一版」。实测的毛病：
 *
 * 1. 宽屏上插画的手臂伸进右栏，压住了字标（door.css 宽屏那段只裁竖直方向）——欢迎页同样
 * 2. 输入框空着时文字居中，光标落在占位符正中间（`XXXX XX|XX XXXX`），像坏了
 * 3. 码按「四个一组 + 空格」显示在同一个输入框里，在中间删改一个字，光标就跳到末尾
 * 4. 输入框下面那排刻度和占位符的分组是同一件事说两遍
 * 5. 「为什么要重新配对」这件事页面上一个字都没有——而换了地址的人最想知道的就是这个
 *
 * 现在：12 个格子分三组，背后是**一个真的输入框**（透明地盖在格子上）——手机键盘、
 * 输入法、读屏、粘贴、密码管理器全照常工作；格子只是把它的值画出来。光标永远在末尾，
 * 删改从末尾来，第 3 条的问题就不存在了。
 *
 * ## 码怎么收
 *
 * 字母表是 ABCDEFGHJKLMNPQRSTUVWXYZ23456789（src/http/auth.js），去掉了易混的 0 O 1 I。
 * 非法字符**直接过滤**，不弹错误——用户把 O 打成 0 不是错误，是这套字母表本来就不该收。
 * 粘贴一整条配对链接（`…/pair?c=XXXXXXXXXXXX`）也认：先取 `c=` 后面那段。
 *
 * **手动打满 12 位或者粘贴满，直接提交**：剩下那一下点击没有任何信息量。
 * **从链接带进来的码只预填、不自动提交**：码是一次性的，页面刷新一次、链接被点开两次，
 * 码就烧掉了，第二次点开的人只会看到「码已失效」，不知道是自己点了两下。
 */

function sanitize(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((ch) => CODE_ALPHABET.includes(ch))
    .join('')
    .slice(0, CODE_LENGTH);
}

/** 粘进来的可能是整条链接：先取 c= 那段，否则整串过滤 */
function extract(raw: string): string {
  const m = /[?&]c=([^&#\s]+)/i.exec(raw);
  return sanitize(m ? m[1] : raw);
}

/**
 * 链接里带的码。`npm run pair` 打出来的就是 `…/pair?c=XXXXXXXXXXXX`——
 * 拿到链接的人已经把码带在身上了，还让他照着链接手打 12 位是纯粹的折磨
 * （而且多半是在手机上）。
 */
function codeFromUrl(): string {
  try {
    return sanitize(new URLSearchParams(window.location.search).get('c') ?? '');
  } catch {
    return '';
  }
}

export function Pair() {
  const { locale, t } = useI18n();
  const [fromLink] = useState(() => codeFromUrl().length === CODE_LENGTH);
  const [code, setCode] = useState(codeFromUrl);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [focused, setFocused] = useState(false);
  // 每失败一次加一：作为格子的 key，让抖动的动画能重放
  const [miss, setMiss] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const full = code.length === CODE_LENGTH;

  useEffect(() => {
    input.current?.focus();
  }, []);

  // 失败之后：提交时输入框是禁用的，焦点丢了。拿回来并全选——最常见的失败是码过期，
  // 下一步就是贴一个新的，全选着直接粘贴就替换掉了
  useEffect(() => {
    if (!miss) return;
    input.current?.focus();
    input.current?.select();
  }, [miss]);

  async function submit(c: string) {
    if (c.length !== CODE_LENGTH || busy || done) return;
    setBusy(true);
    setErr(null);
    try {
      await api.pair(c);
      setDone(true);
      // 留半秒给「接住了」那一下，再整页跳转：配对后服务端给了新 cookie，
      // 让下一次加载从干净状态开始，省得去想哪些内存状态该失效
      setTimeout(() => {
        window.location.href = '/';
      }, 700);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
      setMiss((n) => n + 1);
    }
  }

  function onChange(raw: string) {
    const next = extract(raw);
    setCode(next);
    if (err) setErr(null);
    // 这一下把它填满了（打完最后一位，或者一次粘贴进来）：直接送
    if (next.length === CODE_LENGTH && code.length < CODE_LENGTH) void submit(next);
  }

  const phase = busy || done ? 'toss' : err ? 'miss' : 'idle';
  const host = window.location.host;
  const nextLocale = locale === 'zh' ? 'en' : 'zh';

  return (
    <div className="door door-pair">
      <button
        type="button"
        className="door-lang"
        onClick={() => setPrefs({ locale: nextLocale })}
        aria-label={t('lang.toggleLabel')}
      >
        {locale === 'zh' ? 'EN' : '中文'}
      </button>

      {/*
        和首屏同一幅、同一个位置。球的高度就是这一页的进度：码每多一个字符
        往上走一格，抄满 12 位它被抛到两手之间，送出去时被上面那只手接住，
        失败了掉下来再弹回去（见 Handoff.tsx）。它只是把输入框里已经有的信息
        再画一遍，所以对读屏整个隐藏。
      */}
      <div className="door-art" aria-hidden="true">
        <Handoff progress={code.length / CODE_LENGTH} phase={phase} />
      </div>

      {/* 字标**不做成链接**：这一页只有一个动作，不放任何可点的旁支 */}
      <header className="door-top">
        <span className="door-brand">
          <Wordmark />
        </span>
      </header>

      <main className="door-main">
        <form
          className="pair-form door-body"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void submit(code);
          }}
        >
          {/* 宽屏上字标在这里，不在右栏顶上——那个角会被插画的手臂盖住（door.css） */}
          <span className="door-brand-inline" aria-hidden="true">
            <Wordmark />
          </span>
          <p className="pair-eyebrow">{t('pair.eyebrow')}</p>
          <h1 className="pair-title">{done ? t('pair.doneTitle') : t('pair.title')}</h1>
          <p className="pair-sub">
            {done
              ? t('pair.doneSub')
              : fromLink && full
                ? t('pair.linkSub')
                : t('pair.defaultSub')}
          </p>

          {/*
            格子是画出来的，输入框透明地盖在上面——点格子就是点输入框。
            key 跟着失败次数变：失败一次就整组重挂一次，抖动动画从头放
          */}
          <div
            key={miss}
            className={`cells${focused ? ' is-focus' : ''}${err ? ' is-miss' : ''}${done ? ' is-done' : ''}`}
          >
            <input
              ref={input}
              className="cells-input"
              value={code}
              onChange={(e) => onChange(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              // 手机上直接出大写字母键盘；one-time-code 让系统能从短信 / 剪贴板建议填入
              inputMode="text"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="one-time-code"
              spellCheck={false}
              // 不设 maxLength：粘贴一整条链接要先进来，再由 extract 取出码
              aria-label={t('pair.inputLabel')}
              aria-invalid={err ? true : undefined}
              aria-describedby={err ? 'pair-error' : 'pair-host'}
              disabled={busy || done}
            />
            {[0, 1, 2].map((g) => (
              <span className="cells-group" key={g} aria-hidden="true">
                {[0, 1, 2, 3].map((k) => {
                  const i = g * 4 + k;
                  const ch = code[i];
                  // 光标在下一个要填的那格；填满了就不画
                  const here = focused && !busy && !done && i === code.length;
                  return (
                    <span key={k} className={`cell${ch ? ' is-filled' : ''}${here ? ' is-here' : ''}`}>
                      {ch ?? ''}
                    </span>
                  );
                })}
              </span>
            ))}
          </div>

          <button className="pair-go" type="submit" disabled={!full || busy || done}>
            {done
              ? t('pair.btnDone')
              : busy
                ? t('pair.btnBusy')
                : full
                  ? t('pair.btnReady')
                  : t('pair.btnMissing', { n: CODE_LENGTH - code.length })}
          </button>

          {err && (
            <p className="pair-error" id="pair-error" role="alert">
              <span className="pair-error-msg">{err.message}</span>
              <span className="pair-error-fix">{err.fix}</span>
            </p>
          )}

          <p className="pair-host" id="pair-host">
            <span className="pair-host-dot" aria-hidden="true" />
            <span>{t('pair.hostNote', { host })}</span>
          </p>

          <details className="pair-help">
            <summary>{t('pair.helpSummary')}</summary>
            <ol className="pair-steps">
              <li>
                <span className="pair-step-text">{t('pair.step1')}</span>
              </li>
              <li>
                <span className="pair-step-text">{t('pair.step2')}</span>
                <span className="pair-cmd">
                  <code>npx baton pair</code>
                  <button type="button" className="pair-copy" onClick={() => copyText('npx baton pair', t('pair.copiedCmd'))}>
                    {t('pair.copy')}
                  </button>
                </span>
              </li>
              <li>
                <span className="pair-step-text">{t('pair.step3')}</span>
              </li>
            </ol>
            <p className="pair-help-note">
              {t('pair.guestHint')} <code>npx baton pair --for guest</code>
            </p>
          </details>
        </form>
      </main>
      <Toasts />
    </div>
  );
}
