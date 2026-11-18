import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const src = fs.readFileSync(path.resolve('web/src/i18n.ts'), 'utf8');

function extractKeys(blockName) {
  const m = new RegExp(`const ${blockName}\\b[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`).exec(src);
  assert.ok(m, `missing ${blockName} block in web/src/i18n.ts`);
  const keys = [];
  for (const match of m[1].matchAll(/^\s*'([^']+)'\s*:/gm)) {
    keys.push(match[1]);
  }
  return keys.sort();
}

test('web/src/i18n.ts has 1:1 key parity between EN and ZH', () => {
  const enKeys = extractKeys('EN');
  const zhKeys = extractKeys('ZH');
  assert.ok(enKeys.length >= 100);
  assert.deepEqual(zhKeys, enKeys);
});

test('resolveLocale behavior preserves Node headless zh fallback and browser auto-detection', () => {
  assert.match(src, /if\s*\(pref\s*===\s*'en'\s*\|\|\s*pref\s*===\s*'zh'\)\s*return\s*pref/);
  assert.match(src, /if\s*\(!navLang\)\s*return\s*'zh'/);
  assert.match(src, /\/\^zh\\b\/i\.test\(navLang\)/);
});
