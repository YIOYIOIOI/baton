import { cachedListing, fetchListing, setFileIdentity } from '../files';
import { draftScope } from '../browserSession';
import type { Client } from '../../api/client';
import type { FileListing } from '../../api/types';

const fixture: FileListing = { cwd: 'synthetic', path: '', parent: null, entries: [{ name: 'private.txt', dir: false, size: 0, mtime: 0 }] };
const files = jest.fn();
const client = { files } as unknown as Client;
afterEach(() => { setFileIdentity(null); files.mockReset(); });

test('changing the identity generation at the same session key discards directory names and an outstanding old request', async () => {
  setFileIdentity(draftScope('https://baton.example.test', 'reader', 'first'));
  files.mockResolvedValueOnce(fixture);
  await fetchListing(client, 'same', '');
  expect(cachedListing('same', '')).toBe(fixture);
  let complete!: (data: FileListing) => void;
  files.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  const old = fetchListing(client, 'same', 'nested');
  setFileIdentity(draftScope('https://baton.example.test', 'reader', 'second'));
  complete(fixture);
  await expect(old).rejects.toThrow('stale_listing');
  expect(cachedListing('same', '')).toBeNull();
  expect(cachedListing('same', 'nested')).toBeNull();
});

test.each([401, 403, 404])('revoked or missing directory removes cached names on HTTP %d', async (status) => {
  setFileIdentity(draftScope('https://baton.example.test', 'reader'));
  files.mockResolvedValueOnce(fixture).mockRejectedValueOnce({ status });
  await fetchListing(client, 'same', '');
  await expect(fetchListing(client, 'same', '')).rejects.toMatchObject({ status });
  expect(cachedListing('same', '')).toBeNull();
});
