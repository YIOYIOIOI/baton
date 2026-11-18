import { en, EN, NEW_ZH, resolveAppLocale, trNew, type NewKey } from '../i18n';

describe('app i18n', () => {
  it('resolves explicit preferences immediately', () => {
    expect(resolveAppLocale('en', 'zh-CN')).toBe('en');
    expect(resolveAppLocale('zh', 'en-US')).toBe('zh');
  });

  it('resolves auto from system language with zh fallback', () => {
    expect(resolveAppLocale('auto', 'en-US')).toBe('en');
    expect(resolveAppLocale('auto', 'fr-FR')).toBe('en');
    expect(resolveAppLocale('auto', 'zh-Hans-CN')).toBe('zh');
    expect(resolveAppLocale('auto', '')).toBe('zh');
    expect(resolveAppLocale('auto', null)).toBe('zh');
  });

  it('provides EN parity for every NEW_ZH key', () => {
    for (const k of Object.keys(NEW_ZH) as NewKey[]) {
      expect(typeof EN[k]).toBe('string');
      expect(EN[k].length).toBeGreaterThan(0);
    }
  });

  it('interpolates template placeholders cleanly', () => {
    expect(trNew('en', 'about.pairExpires', { sec: 600 })).toContain('600');
    expect(trNew('zh', 'about.pairExpires', { sec: 600 })).toContain('600');
    expect(en('list.archived', { n: 4 })).toBe('4 archived');
  });
});
