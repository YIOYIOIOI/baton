/**
 * 进程级兜底：漏网的 Promise 拒绝只记日志，不让守护进程退出。
 *
 * 请求处理已经在 http/server.js 里整个兜住了；这里接的是别处的漏网之鱼，比如
 * 某个发起后不等的 `.then()` 链。Node 的默认做法是让整个进程退出，而这个进程一退：
 * 手机上所有会话都断，正在跑的轮次没人收尾，agent 子进程变成没人管的孤儿。
 * 为一个多半只是没接住的 Promise 付这个代价不值，所以记下来、继续跑。
 *
 * 同步抛出的 uncaughtException **不接**：那说明某个调用栈已经处在不知道什么
 * 状态了，接着跑比退出更危险。它照 Node 的默认打印并退出，由 start-daemon.ps1
 * 的外层循环重新拉起来。
 */
export function installGuards({ log = (msg) => console.error(msg) } = {}) {
  process.on('unhandledRejection', (/** @type {any} */ reason) => {
    log(`  ⚠ 有个 Promise 被拒绝了却没人处理（已记下，进程继续）：${reason?.stack ?? reason}`);
  });
}
