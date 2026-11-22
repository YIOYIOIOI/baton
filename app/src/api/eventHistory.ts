type Entry = { id: string; offset: number };
type Page<E extends Entry> = { events: E[]; nextBefore: number | null; endOffset: number };

/** A capped SSE replay needs the missing pages as well as the newest page's resume cursor. */
export async function historyAfter<E extends Entry>(
  from: number, read: (before?: number) => Promise<Page<E>>, active: () => boolean,
) {
  let page = await read();
  const endOffset = page.endOffset;
  const pages = [page.events];
  while (active() && page.nextBefore !== null && page.nextBefore > from) {
    const before = page.nextBefore;
    page = await read(before);
    if (page.nextBefore !== null && page.nextBefore >= before) throw new Error('Invalid history cursor');
    pages.push(page.events);
  }
  const events = pages.reverse().flat().filter((e) => e.offset >= from);
  return { events, endOffset };
}
