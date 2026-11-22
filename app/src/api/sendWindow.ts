/** The server retains an accepted request ID for at least 24 hours. */
export function canRetrySend(startedAt: unknown, now = Date.now()): boolean {
  return typeof startedAt === 'number' && Number.isFinite(startedAt)
    && now >= startedAt && now - startedAt < 24 * 60 * 60 * 1000;
}
