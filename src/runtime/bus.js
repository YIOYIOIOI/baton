// 轮次生命周期的进程内广播。
//
// 为什么需要它：Claude 的 transcript 里**没有轮次终态记录**（实测 claude
// events=1782 turn_end=0 / codex events=1919 turn_end=42）。终态只存在于子进程
// stdout 汇总出来的 ~/.baton/runs/*.json 里。而 streamSession 原先只挂了一个
// transcript follower——于是 Claude 会话的运行轴永远停在「进行中」，
// 这正是 Baton 立项要消灭的「永远 Thinking」换了个成因。
//
// 发射点放在 runtime/turns.js 的写入处，不放在调用点。sendMessage、stopTurn、
// reconcileOrphans 都会写轮次记录，逐个去调用点埋发射迟早漏一条——
// 而「漏一条路径」正是上面那个 bug 的成因本身。

const listeners = new Map(); // key -> Set<fn>

export function subscribeTurns(key, fn) {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return function unsubscribe() {
    set.delete(fn);
    if (set.size === 0) listeners.delete(key);
  };
}

export function emitTurn(key, type, turn) {
  const set = listeners.get(key);
  if (!set) return 0;
  let delivered = 0;
  // 复制一份再遍历：这一次事件只发给**发出那一刻**在场的订阅者。回调里退订
  // （SSE 流关闭）、甚至退订别人都是正常操作；不复制的话，被别人退订掉的那个
  // 会收不到这一次。（订阅者只退订自己时，直接遍历 Set 并不会跳过后面的。）
  // oxlint-disable-next-line unicorn/no-useless-spread -- 要的就是这份快照
  for (const fn of [...set]) {
    try {
      fn({ type, turn });
      delivered += 1;
    } catch {
      // 一个订阅者抛错不能拖垮其他订阅者，更不能把异常甩回写轮次记录的那条路径
    }
  }
  return delivered;
}

// 仅供测试：确认流关闭后确实退订了，不会泄漏
export function listenerCount(key) {
  return listeners.get(key)?.size ?? 0;
}
