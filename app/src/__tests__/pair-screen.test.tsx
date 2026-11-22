import { act } from 'react';
import { Platform, TextInput } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import PairScreen from '../app/pair';
import { Scanner, parseScanned } from '../components/Scanner';
import { useLocalePref } from '../store/locale';

const mockPair = jest.fn(async (_origin: string, _code: string) => {});
let mockPageOrigin: string | null = 'https://current.example.test';
let mockSavedUrl: string | null = 'https://previous.example.test';
jest.mock('@/store/connection', () => ({
  pageOrigin: () => mockPageOrigin,
  useConnection: (select: (state: { baseUrl: string | null; pair: typeof mockPair }) => unknown) =>
    select({ baseUrl: mockSavedUrl, pair: mockPair }),
}));
jest.mock('expo-router', () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({}),
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/components/Scanner', () => ({
  ...jest.requireActual('../components/Scanner'),
  Scanner: () => null,
}));

let view: ReactTestRenderer;
async function openPair(platform: 'web' | 'ios') {
  jest.replaceProperty(Platform, 'OS', platform);
  useLocalePref.setState({ pref: 'en' });
  await act(async () => { view = create(<PairScreen />); });
}

async function scan(raw: string) {
  const result = parseScanned(raw);
  if (!result) throw new Error('Expected a pairing QR');
  await act(async () => { view.root.findByType(Scanner).props.onScan(result); });
}

function submitButton() {
  let button = view.root.find((item) => item.children.includes('Pair with Code')).parent;
  while (button && typeof button.props.onPress !== 'function') button = button.parent;
  if (!button) throw new Error('Missing manual pairing button');
  return button;
}

afterEach(async () => {
  if (view) await act(async () => { view.unmount(); });
  jest.restoreAllMocks();
  mockPair.mockClear();
  mockPageOrigin = 'https://current.example.test';
  mockSavedUrl = 'https://previous.example.test';
});

test('the first Web render matches static Chinese before switching to the browser language', async () => {
  jest.replaceProperty(Platform, 'OS', 'web');
  const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');
  Object.defineProperty(navigator, 'language', { configurable: true, value: 'en-US' });
  try {
    useLocalePref.setState({ pref: 'auto', ready: false });
    await act(async () => { view = create(<PairScreen />); });
    expect(view.root.findAll((item) => item.children.includes('连上那台电脑')).length).toBeGreaterThan(0);
    await act(async () => { useLocalePref.setState({ ready: true }); });
    expect(submitButton()).toBeDefined();
  } finally {
    if (originalLanguage) Object.defineProperty(navigator, 'language', originalLanguage);
    else Reflect.deleteProperty(navigator, 'language');
  }
});

test.each(['https://other.example.test', 'https://current.example.test:8443', 'http://current.example.test'])(
  'PWA points to %s without submitting or prefilling its code, then accepts a fresh local scan',
  async (elsewhere) => {
    await openPair('web');
    await scan(`${elsewhere}/pair?c=ABCD2345EFGH`);
    expect(mockPair).not.toHaveBeenCalled();
    expect(view.root.findByType(TextInput).props.value).toBe('');
    expect(view.root.findAll((item) => item.children.some((child) =>
      typeof child === 'string' && child.includes(elsewhere))).length).toBeGreaterThan(0);

    await scan('https://CURRENT.example.test:443/pair?c=JKLM2345NPQR');
    expect(mockPair.mock.calls).toEqual([['https://current.example.test', 'JKLM2345NPQR']]);
  },
);

test('PWA keeps manual pairing and bare QR codes on the current origin', async () => {
  await openPair('web');
  await act(async () => { view.root.findByType(TextInput).props.onChangeText('ABCD2345EFGH'); });
  expect(mockPair).not.toHaveBeenCalled();
  await act(async () => { await submitButton().props.onPress(); });
  await scan('JKLM2345NPQR');
  expect(mockPair.mock.calls).toEqual([
    ['https://current.example.test', 'ABCD2345EFGH'],
    ['https://current.example.test', 'JKLM2345NPQR'],
  ]);
});

test('native pairing uses the host in the QR even when another host was previously saved', async () => {
  await openPair('ios');
  await scan('http://next.example.test:8443/pair?c=ABCD2345EFGH');
  expect(mockPair.mock.calls).toEqual([['http://next.example.test:8443', 'ABCD2345EFGH']]);
});

test('PWA without a page origin hides the address input and waits instead of pairing with a saved host', async () => {
  mockPageOrigin = null;
  await openPair('web');
  expect(view.root.findAllByType(TextInput)).toHaveLength(1);
  await scan('ABCD2345EFGH');
  expect(submitButton().props.disabled).toBe(true);
  expect(mockPair).not.toHaveBeenCalled();
});

test('native bare QR waits for an address before pairing', async () => {
  mockSavedUrl = null;
  await openPair('ios');
  await scan('ABCD2345EFGH');
  expect(submitButton().props.disabled).toBe(true);
  expect(mockPair).not.toHaveBeenCalled();
  const host = view.root.findAllByType(TextInput).find((field) => field.props.inputMode === 'url');
  if (!host) throw new Error('Missing native address input');
  await act(async () => { host.props.onChangeText('https://entered.example.test'); });
  expect(mockPair.mock.calls).toEqual([['https://entered.example.test', 'ABCD2345EFGH']]);
});
