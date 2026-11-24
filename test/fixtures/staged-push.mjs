import fs from 'node:fs';
import path from 'node:path';
import { subscribe } from '../../src/push.js';

const [principalId, deviceId, endpoint] = process.argv.slice(2);
const file = path.join(process.env.BATON_DIR, 'push.json');
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (to === file) {
    process.send('staged');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  }
  return rename(from, to);
};
process.once('message', () => {
  subscribe({ endpoint }, principalId, deviceId);
  process.disconnect();
});
