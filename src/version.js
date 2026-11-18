import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

/** Current Baton package version read from package.json. */
export const VERSION = String(pkg.version || '0.0.0');
