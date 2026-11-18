// 错误响应的统一形状。每个失败都要说清「怎么修」（v1 §3 第 8 条），所以 fix 是必填的。
//
// 2026-10-01 从 src/http/api.js 拆出来（那个文件当时 1661 行、40 个导出）。



export function errorBody(code, message, fix) {
  return { error: { code, message, fix } };
}
