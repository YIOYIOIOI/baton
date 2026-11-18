import { useEffect, useState } from 'react';
import { Ball } from './Ball';

/**
 * 首屏的主角：一段正在跑的会话。
 *
 * 为什么用它当主角而不是那幅交接插画——插画是按 402×874 竖屏画的，放多大都还是
 * 手机构图，而 Baton 的实质不是隐喻，是「你走开了，活没停」。让页面上真有一段
 * 在流的东西，比画一只手更接近这件事，也是只有宽屏才铺得开的东西。
 * （插画后来回到了首屏左边那条竖带里，见 Welcome.tsx；主角仍是这一段。）
 *
 * **不套设备外壳，不加浏览器 chrome。** 那两样是这个品类的默认款；内容自己立得住
 * 就不需要框。
 *
 * 它长得和真的会话页一样：用户那句是墨色气泡，工具一行一颗珠子，agent 的话是
 * 衬线正文，末尾是那颗在转的球。**示意就该是真东西的缩样**——配对进去之后
 * 看到的如果是另一副样子，这一段就成了广告图。
 *
 * 「交接」不另画示意图：它就发生在这段会话里——`from: 'phone'` 那条消息标着
 * 它来自手机，一颗球从画外抛进来落在那儿。
 *
 * 内容是**示意**，不是任何人的真实会话。刻意用一个泛泛的结账优惠码场景。
 */

type Turn =
  | { kind: 'user'; text: string; from?: 'phone' }
  | { kind: 'tool'; name: string; family: 'read' | 'edit' | 'shell'; arg: string; meta?: string }
  | { kind: 'result'; text: string }
  | { kind: 'assistant'; text: string };

const TURNS: Turn[] = [
  { kind: 'user', text: '结账页的优惠码校验坏了，过期的码还能用' },
  { kind: 'tool', name: 'Read', family: 'read', arg: 'src/checkout/coupon.ts' },
  { kind: 'tool', name: 'Edit', family: 'edit', arg: 'src/checkout/coupon.ts', meta: '+12 −4' },
  { kind: 'tool', name: 'Bash', family: 'shell', arg: 'npm test -- coupon' },
  { kind: 'result', text: '14 passed' },
  {
    kind: 'assistant',
    text: '过期判断读的是本地时区，服务端按 UTC 存。已改成统一用 UTC 比较，并补了一个跨时区的用例。',
  },
  // 这一条是整页唯一需要读者停一下的地方：活从手机上接着往下派。
  { kind: 'user', text: '退款那条也是同一个毛病，一起改了', from: 'phone' },
  { kind: 'tool', name: 'Read', family: 'read', arg: 'src/checkout/refund.ts' },
];

const STEP_MS = 420;

export function Session() {
  // 逐条显露，**只在载入时跑一次**，不做无限循环。
  // 持续运动会一直抢注意力；一次编排好的入场足够说明「它是活的」。
  const [shown, setShown] = useState(() =>
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
      ? TURNS.length
      : 0,
  );

  useEffect(() => {
    if (shown >= TURNS.length) return;
    // 插画的入场先放完（约 1.1 秒），这一段再开始流
    const t = setTimeout(() => setShown((n) => n + 1), shown === 0 ? 900 : STEP_MS);
    return () => clearTimeout(t);
  }, [shown]);

  const last = TURNS.length - 1;

  return (
    <div className="session" aria-label="一段 Baton 会话的示意">
      <div className="session-head">
        <span className="session-agent">claude</span>
        <span className="session-cwd">~/shop-web</span>
        <span className="session-live">
          <i className="session-dot" aria-hidden="true" />
          运行中
        </span>
      </div>

      <ol className="session-body">
        {TURNS.slice(0, shown).map((turn, i) => (
          <li key={i} className={`turn turn-${turn.kind}`}>
            {turn.kind === 'user' && (
              <>
                {turn.from === 'phone' && (
                  <span className="from">
                    <Toss />
                    从手机接过来
                  </span>
                )}
                <p className="said">{turn.text}</p>
              </>
            )}

            {turn.kind === 'tool' && (
              <p className="tool">
                {/* 最后那一步还没有结果：珠子是蓝的、在呼吸，和真会话页一个样 */}
                <i className={`bead is-${turn.family}${i === last ? ' is-live' : ''}`} aria-hidden="true" />
                <span className="tool-name">{turn.name}</span>
                <span className="tool-arg">{turn.arg}</span>
                {turn.meta && <span className="tool-meta">{turn.meta}</span>}
                {i === last && <span className="tool-meta is-live">运行中</span>}
              </p>
            )}

            {turn.kind === 'result' && <p className="result">{turn.text}</p>}

            {turn.kind === 'assistant' && <p className="assistant">{turn.text}</p>}
          </li>
        ))}
      </ol>

      {/* 末尾那颗在转的球：会话没有结束，只是轮到下一步。真会话页的状态栏就是它 */}
      <span className="session-foot ball-live" aria-hidden="true">
        <Ball size={17} />
      </span>
    </div>
  );
}

/**
 * 「从手机接过来」前面那一小段抛物线：一颗球从画外飞进来，落在这行字前面。
 * 虚线是它飞过的路，出现一次就停——它说的是「刚刚发生了一次交接」。
 */
function Toss() {
  return (
    <svg className="toss" width="30" height="16" viewBox="0 0 30 16" aria-hidden="true" focusable="false">
      <path className="toss-path" d="M2 14 C 8 1, 18 1, 24 10" fill="none" />
      <circle className="toss-ball" cx="24" cy="10" r="3.2" />
    </svg>
  );
}
