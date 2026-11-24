import fs from 'node:fs';
import { fileRevocations } from '../../src/revocations.js';

const [file, kind] = process.argv.slice(2);
const store = fileRevocations(file);
const secondFinished = `${file}.second-finished`;
process.once('message', () => {
  if (kind === 'device') {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === file) {
        process.send('staged');
        // Leave the first snapshot pending while the second writer attempts its update.
        const deadline = Date.now() + 400;
        const timer = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(secondFinished) && Date.now() < deadline) Atomics.wait(timer, 0, 0, 10);
      }
      return rename(from, to);
    };
    store.revoke('dev-a', 'owner');
  } else {
    store.revokeLegacy('friend');
    fs.writeFileSync(secondFinished, '');
  }
  process.disconnect();
});
process.send('ready');
