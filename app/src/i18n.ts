import { useLocalePref, type LocalePref } from '@/store/locale';

export type AppLocale = 'en' | 'zh';

function detectSystemLocale(): string | null {
  try {
    const nav = (globalThis as { navigator?: { language?: string } }).navigator;
    if (nav?.language) return nav.language;
  } catch {
    // Ignore missing navigator in Node pre-render or tests.
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? null;
  } catch {
    return null;
  }
}

export function resolveAppLocale(pref: LocalePref, systemLang?: string | null): AppLocale {
  if (pref === 'en' || pref === 'zh') return pref;
  const raw = systemLang !== undefined ? systemLang : detectSystemLocale();
  if (!raw || !raw.trim()) return 'zh';
  return raw.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export const NEW_ZH = {
  'lang.label': '语言',
  'lang.auto': '自动',
  'lang.en': 'English',
  'lang.zh': '中文',
  'about.devices': '已连接设备',
  'about.devicesLoading': '正在加载设备列表…',
  'about.devicesEmpty': '暂无已连接设备',
  'about.devicesErr': '设备列表加载失败',
  'about.currentDevice': '当前设备',
  'about.ownerTag': 'Owner',
  'about.guestTag': '访客',
  'about.revoke': '吊销',
  'about.revokeAsk': '确认吊销这台设备？',
  'about.revokeBody': '吊销后该设备将立即失去访问权限。',
  'about.revokeCurrent': '这是当前设备，解除访问请在页面底部点击取消配对。',
  'about.lastSeen': '活跃：{time}',
  'about.pairSection': '新增配对',
  'about.pairGenerate': '生成配对二维码',
  'about.pairGenerating': '生成中…',
  'about.pairRefresh': '刷新二维码',
  'about.pairCode': '配对码',
  'about.pairExpires': '有效期 {sec} 秒 · 仅限单次使用',
  'about.pairCopy': '复制配对链接',
  'about.pairCopied': '已复制到剪贴板',
  'about.pairErr': '无法生成配对二维码',
  'about.daemonVersion': '服务端版本',
  'about.disclaimer': 'Baton 为独立开源项目，与 Anthropic、OpenAI 或 Google 无官方关联。',
  'menu.exportMd': '导出 Markdown',
  'menu.exporting': '正在导出…',
  'session.exportFail': '导出 Markdown 失败',
  'session.shareUnavailable': '当前系统不支持文件分享导出',
} as const;

export const EN = {
  ...NEW_ZH,
  'lang.label': 'Language',
  'lang.auto': 'Auto',
  'lang.en': 'English',
  'lang.zh': '中文',
  'about.devices': 'Connected Devices',
  'about.devicesLoading': 'Loading devices…',
  'about.devicesEmpty': 'No connected devices yet',
  'about.devicesErr': 'Failed to load devices',
  'about.currentDevice': 'This device',
  'about.ownerTag': 'Owner',
  'about.guestTag': 'Guest',
  'about.revoke': 'Revoke',
  'about.revokeAsk': 'Revoke this device?',
  'about.revokeBody': 'It will lose access immediately and must pair again.',
  'about.revokeCurrent': 'This is your active session. Use Unpair below to disconnect.',
  'about.lastSeen': 'Active {time}',
  'about.pairSection': 'Pair Another Device',
  'about.pairGenerate': 'Generate Pairing QR',
  'about.pairGenerating': 'Generating…',
  'about.pairRefresh': 'Refresh QR',
  'about.pairCode': 'Pairing Code',
  'about.pairExpires': 'Expires in {sec}s · single use',
  'about.pairCopy': 'Copy Pair Link',
  'about.pairCopied': 'Copied to clipboard',
  'about.pairErr': 'Could not create pairing QR',
  'about.daemonVersion': 'Daemon',
  'about.disclaimer': 'Independent open-source project; not affiliated with Anthropic, OpenAI, or Google.',
  'menu.exportMd': 'Export Markdown',
  'menu.exporting': 'Exporting…',
  'session.exportFail': 'Could not export Markdown',
  'session.shareUnavailable': 'File sharing is unavailable on this device',

  // Welcome
  'welcome.connect': 'Connect Host',
  'welcome.artA11y': 'Two hands passing a relay baton',

  // Pair
  'pair.h1': 'Connect to your computer',
  'pair.lede': 'Pair once; stays signed in.',
  'pair.hostPlaceholder': 'baton.example.com',
  'pair.hostA11y': 'Baton server URL',
  'pair.codeA11y': '12-character pairing code',
  'pair.scan': 'Scan QR Code',
  'pair.submit': 'Pair with Code',
  'pair.footPrefix': 'Run ',
  'pair.footMid': ' on your host machine,\nscan the QR code, or enter the 12-character code.',

  // List screen
  'list.tabAll': 'All',
  'list.emptyTitle': 'No sessions yet',
  'list.emptyBody': 'Start one on your host machine, or create one below',
  'list.emptyFiltered': 'No sessions',
  'list.archived': '{n} archived',
  'list.fork': 'Fork',
  'list.statusRunning': 'Running',
  'list.statusWaiting': 'Waiting for input',
  'list.statusIdle': 'Idle',

  // About screen
  'about.title': 'Settings',
  'about.usageGroup': 'Usage',
  'about.connectionGroup': 'Connection',
  'about.host': 'Host',
  'about.unpaired': 'Not paired',
  'about.status': 'Status',
  'about.appearanceGroup': 'Appearance',
  'about.theme': 'Theme',
  'about.themeSystem': 'System',
  'about.themeLight': 'Light',
  'about.themeDark': 'Dark',
  'about.notificationsGroup': 'Notifications',
  'about.notifyDone': 'Notify when done',
  'about.aboutGroup': 'About',
  'about.reload': 'Reload Page',
  'about.reloadHint': 'Use after upgrading the host or if the page stalls',
  'about.guide': 'User Guide',
  'about.appVersion': 'App Version',
  'about.unpair': 'Unpair',
  'about.unpairTitle': 'Unpair this device?',
  'about.unpairAsk': 'You will need a new code to reconnect; host URL stays saved.',
  'about.cancel': 'Cancel',
  'about.confirmUnpair': 'Unpair',
  'about.helpH1': 'Dimmed status dot',
  'about.helpP1': 'Disconnected from host; live progress may be outdated.',
  'about.helpH2': 'Sending while running',
  'about.helpP2': 'Messages queue and send after the current turn finishes. Use Stop on the left to interrupt.',
  'about.helpH3': 'Faded session titles',
  'about.helpP3': 'Inferred by Baton; normal weight titles match the host app.',
  'about.helpH4': 'Uploading files',
  'about.helpP4': 'Files upload into the session workspace directory and their paths are attached to your message.',
  'about.helpH5': 'New mobile sessions on desktop',
  'about.helpP5': 'The session is ready immediately; restart the desktop app if it has not indexed yet.',
  'about.pushOn': 'Notifies when a turn finishes.',
  'about.pushOff': 'Get notified when turns finish instead of watching.',
  'about.pushDenied': 'Enable notification permissions for Baton in system settings.',
  'about.pushHomescreen': 'Add this page to your Home Screen first — iOS only allows Web Push for installed web apps.',
  'about.pushUnsupported': 'Notifications are not supported in this browser.',

  // Notice & Link status
  'link.ok': 'Connected',
  'link.retryingTitle': 'Reconnecting',
  'link.retryingBody': 'Showing content from before disconnect',
  'link.offlineTitle': 'No network connection',
  'link.offlineBody': 'Will reconnect automatically',
  'link.originTitle': 'Host not responding',
  'link.originBody': 'Computer may be asleep',
  'link.interceptedTitle': 'Network login required',
  'link.interceptedBody': 'Sign in and return',
  'link.retry': 'Retry',
  'link.portal': 'Open Browser',

  // New session
  'new.greetNight': 'Up late',
  'new.greetMorning': 'Good morning',
  'new.greetAfternoon': 'Good afternoon',
  'new.greetEvening': 'Good evening',
  'new.placeholder': 'What should it work on?',
  'new.pickDir': 'Directory',
  'new.createDir': 'Create Folder',
  'new.uploadErr': 'Failed to upload attachment: {err}',
  'new.uploadFix': 'Send again — already uploaded files will be skipped.',

  // Session menu
  'menu.close': 'Close',
  'menu.related': 'Related Sessions',
  'menu.detail': 'Detail Level',
  'menu.files': 'Files',
  'menu.sync': 'Refresh',
  'menu.more': 'More',
  'view.summary': 'Summary',
  'view.normal': 'Normal',
  'view.verbose': 'Verbose',
  'view.summaryDesc': 'Final answers only',
  'view.normalDesc': 'Collapse tool calls',
  'view.verboseDesc': 'Expand every step',

  // Usage
  'usage.sheetDesc': 'Remaining plan quota on your host machine. Wait for reset when a window reaches 0%.',
  'usage.refresh': 'Refresh',
  'usage.refreshing': 'Refreshing…',
  'usage.refreshA11y': 'Refresh usage',
  'usage.left': ' left',
  'usage.asking': 'Checking…',
  'usage.unavailableErr': 'Unavailable: {err}',
  'usage.noWindows': 'No quota windows returned by account',
  'usage.stalePrefix': 'Cached · {sub}',
  'usage.resetUnknown': 'Reset time unknown',
  'usage.asOfStale': 'From last turn · {ago}',
  'usage.asOfFresh': 'Updated {ago}',
  'usage.staleNote': 'Recorded after the last Codex turn; usage outside Baton is not included{err}.',
  'usage.extraUsage': 'Over-limit billing is active once quota runs out.',
} as const satisfies Record<string, string>;

export type EnKey = keyof typeof EN;
export type NewKey = keyof typeof NEW_ZH;

function format(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

export function en(key: EnKey, vars?: Record<string, string | number>): string {
  return format(EN[key], vars);
}

export function trNew(locale: AppLocale, key: NewKey, vars?: Record<string, string | number>): string {
  const table = locale === 'en' ? EN : NEW_ZH;
  return format(table[key], vars);
}

export function useLocale() {
  const pref = useLocalePref((s) => s.pref);
  const setPref = useLocalePref((s) => s.set);
  const locale = resolveAppLocale(pref);
  return {
    pref,
    setPref,
    locale,
    isEn: locale === 'en',
    en,
    trNew: (key: NewKey, vars?: Record<string, string | number>) => trNew(locale, key, vars),
  };
}
