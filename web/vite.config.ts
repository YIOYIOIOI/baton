import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 浏览器端客户端。产物是 web/dist/，由 Baton 后端直接 serve
 * （src/http/static.js 的 pickWebRoot 优先选它）。
 *
 * base 保持默认的 '/'：后端把 dist 挂在站点根上，不带前缀。
 */

/**
 * 开发期把 /api 转给跑着的 Baton。默认 3002，与 src/config.js 的 DEFAULTS.port 一致；
 * 起在别的端口上就 `BATON_ORIGIN=http://127.0.0.1:3010 npm run dev`。
 *
 * **必须是代理，不能用后端的 devCorsOrigin。** 那条路刻意不发
 * `Access-Control-Allow-Credentials`（server.js 的 corsHeaders 抬头写了为什么），
 * 于是跨源时浏览器根本不带 cookie，唯一能用的凭据是显式 Bearer——而网页端的整个
 * 凭据模型是「HttpOnly cookie，JS 读不到也不索取 bearer」（api.ts 抬头）。
 * 代理让 dev server 与 API 同源，cookie 照常走，后端一个字都不用改。
 *
 * cookie 带 `Secure`，而这里是明文 http。能成立是因为浏览器把 localhost /
 * 127.0.0.1 当作可信来源（Chrome 89+、Firefox 75+ 起 Secure cookie 可在其上写入）。
 * **Safari 不在此列**——它对 http 一律拒收 Secure cookie，所以本机开发别用 Safari。
 */
const API_TARGET = process.env.BATON_ORIGIN ?? 'http://127.0.0.1:3002';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        // 保持 Host 为 dev server 自己。后端不校验 Host（server.js 解析 req.url
        // 时用的是固定的占位 origin），改写它只会让后端日志里出现一个假的来源。
        changeOrigin: false,
        // SSE 一条流能挂几个小时（会话一直开着），默认的 proxyTimeout 会把它掐断，
        // 表现是「过一阵事件就不来了，也不报错」。0 = 不超时。
        timeout: 0,
        proxyTimeout: 0,
      },
    },
  },
  build: {
    outDir: 'dist',
    /*
     * 后端的 `cacheOf()` 判据是 `/-[0-9a-f]{16,}\./`——**16 位以上、且是十六进制**。
     *
     * 原来这里只调了长度（`[hash:16]`），注释还写着「对上它」。**其实没对上**：
     * Rollup 默认的 hash 字母表是 base64url，`index-C4aPk4Ub2m_66LdL.js` 里有大写
     * 和下划线，正则永远不命中。于是自网页端存在以来，所有资源一直发的是
     * `no-cache`（实测 `Cache-Control: no-cache`），隧道上每次打开重下 455 KB。
     *
     * 长度只是判据的一半，字母表是另一半。`hashCharacters: 'hex'` 补上另一半。
     */
    rollupOptions: {
      output: {
        hashCharacters: 'hex',
        entryFileNames: 'assets/[name]-[hash:16].js',
        chunkFileNames: 'assets/[name]-[hash:16].js',
        assetFileNames: 'assets/[name]-[hash:16][extname]',
      },
    },
  },
});
