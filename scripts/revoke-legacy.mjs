// 把某个身份**升级前配对的那些设备**一起断开。只能在跑着 Baton 的这台机器上执行。
//
// 用法：npm run revoke-legacy               → owner 自己的旧设备
//       npm run revoke-legacy -- --for friend → 访客 friend 的旧设备
//
// 为什么是「一起」：升级前同一身份的所有设备拿的是同一个凭据（token 派生的 HMAC），
// 分不出哪台是哪台。升级后新配的设备各有各的凭据，解除配对就能只断那一台，用不着这个。
// 跑完之后这个身份下没重新配过的设备都会 401，要重新 npm run pair。
//
// 改的是 ~/.baton/revoked.json，守护进程下一个请求就读到，不用重启。
// 参数规则和 npm run pair 完全一样（src/pairargs.js）：看不懂就停，绝不默认成别人。

import path from 'node:path';
import { BATON_DIR } from '../src/config.js';
import { parsePairArgs } from '../src/pairargs.js';
import { loadPrincipals, OWNER_ID } from '../src/principals.js';
import { fileRevocations } from '../src/revocations.js';

const parsed = parsePairArgs(process.argv.slice(2));
if (parsed.ok === false) {
  console.error(`\n  ${parsed.error}\n  ${parsed.fix.replace(/npm run pair/g, 'npm run revoke-legacy')}\n`);
  process.exit(1);
}
const id = parsed.for ?? OWNER_ID;
const { principals } = loadPrincipals();
if (!principals.some((p) => p.id === id)) {
  console.error(`\n  没有这个身份：${id}。看一下 ${path.join(BATON_DIR, 'principals.json')}。\n`);
  process.exit(1);
}

const changed = fileRevocations(path.join(BATON_DIR, 'revoked.json')).revokeLegacy(id);
console.log(changed
  ? `\n  已断开「${id}」升级前配对的全部设备。还要用的设备重新 npm run pair${id === OWNER_ID ? '' : ` -- --for ${id}`} 配一次。\n`
  : `\n  「${id}」的旧设备早就断开过了，没有变化。\n`);
