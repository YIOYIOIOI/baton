import { useLocalePref, type LocalePref } from '@/store/locale';
import { Platform } from 'react-native';

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
  'pair.otherOrigin': '这个二维码对应另一个 Baton 地址。请在浏览器打开 {origin}/pair，再扫描这个二维码。',
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
  'session.stopOnDesktop': 'Baton 正在跟踪 Antigravity 桌面会话。请在桌面端查看进度或停止本轮。',
  'session.desktopUnconfirmed': '桌面执行结果待确认',
  'session.desktopUnconfirmedHelp': 'Baton 重启期间，两轮执行可能交错。队列已暂停。请在 Antigravity 桌面核对结果，再手动发送下一条排队消息。',
  'session.stopping': '正在等待执行进程退出。',
  'pair.unpairPending': '此设备已锁定。恢复连接后会向原电脑重试解除配对。',
  'pair.unconfirmed': '尚未确认配对结果，设备已锁定。请恢复连接或输入新的配对码。',
  'pair.busyElsewhere': '另一个标签页的配对请求尚未结束。请稍后重试；若该标签页已意外关闭，请在新的隐私窗口中配对。',
  'pair.coordination': '此浏览器无法协调多个标签页的配对。请在已启用网站存储的浏览器中打开配对链接。',
  'pair.unpairStorageError': '此设备已锁定，但安全存储未能保存吊销请求。请保持应用打开并联网，直到电脑确认解除配对。',
  'pair.invalidOrigin': '请输入这台 Baton 电脑的 HTTP 或 HTTPS 地址。',
  'session.sentSyncPending': '消息已受理。恢复连接后会更新会话状态。',
  'session.unconfirmedSend': '尚未确认消息是否送达。重试可核实原来的请求。',
  'session.pendingStorage': '无法保存待确认消息。请检查连接和设备可用空间后重试。',
  'session.expiredSend': '原请求已无法安全重试。请先核对会话记录；仍需发送时，请移除这条待确认消息，再重新发送。',
  'session.accepted': '消息已受理',
  'session.promoteFailed': '未能确认是否插队，请查看队列状态。',
} as const;

export const EN = {
  ...NEW_ZH,
  'lang.label': 'Language',
  'lang.auto': 'Auto',
  'lang.en': 'English',
  'lang.zh': '中文',
  'pair.otherOrigin': 'This QR code is for a different Baton address. Open {origin}/pair in your browser and scan it again there.',
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
  'session.stopOnDesktop': 'Baton is monitoring this Antigravity desktop session. Open the desktop app to check progress or stop this turn.',
  'session.desktopUnconfirmed': 'Check the turn in Antigravity Desktop',
  'session.desktopUnconfirmedHelp': 'Two turns may have overlapped while Baton was restarting. The queue is paused. After checking the result on the desktop, you can send the next queued message manually.',
  'session.stopping': 'Waiting for the process to exit.',
  'pair.unpairPending': 'This device is locked. Unpairing will retry with the original computer when it is online.',
  'pair.unconfirmed': 'Pairing could not be verified. This device is locked. Reconnect or enter a new pairing code.',
  'pair.busyElsewhere': 'Another tab has an unfinished pairing request. Wait for it to finish. If that tab closed unexpectedly, pair in a fresh private window.',
  'pair.coordination': 'This browser cannot coordinate pairing across tabs. Open the pairing link in a browser with site storage enabled.',
  'pair.unpairStorageError': 'This device is locked, but secure storage could not save the revocation request. Keep the app open and online until the computer confirms.',
  'pair.invalidOrigin': 'Enter the HTTP or HTTPS address of your Baton computer.',
  'session.sentSyncPending': 'Message accepted. The session status will update when you reconnect.',
  'session.unconfirmedSend': 'Delivery is unconfirmed. Retry to check the original request.',
  'session.pendingStorage': 'Could not save the pending message. Check your connection and available storage, then retry.',
  'session.expiredSend': 'The original request can no longer be retried safely. Check the conversation, then dismiss this entry before sending again.',
  'session.accepted': 'Message accepted',
  'session.promoteFailed': 'Could not confirm the change. Check the queue for this message.',

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
  'dock.sessions': 'Sessions',
  'dock.settings': 'Settings',
  'dock.new': 'New',
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
  const ready = useLocalePref((s) => s.ready);
  const setPref = useLocalePref((s) => s.set);
  // The static Web page and its first hydration must render the same language.
  const locale = resolveAppLocale(pref, Platform.OS === 'web' && !ready ? 'zh' : undefined);
  return {
    pref,
    setPref,
    locale,
    isEn: locale === 'en',
    en,
    trNew: (key: NewKey, vars?: Record<string, string | number>) => trNew(locale, key, vars),
  };
}
