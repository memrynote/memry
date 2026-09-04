/**
 * Which note bodies a pull pass has to fetch.
 *
 * Note bodies do not travel in the record change feed. The feed carries record
 * rows, and a body-only edit writes no record row at all, so `changedNoteIds`
 * names nothing and the pass used to ask for nothing. A peer typing into a
 * note this device already has on screen was simply invisible.
 *
 * The open docs are the union's second half, and they are the heal path. The
 * `crdt_updated` socket broadcast is what makes a body-only edit arrive
 * promptly, but a socket that was down over the edit missed the broadcast for
 * good. Re-asking for the open notes on every pass makes a dropped
 * socket a latency problem rather than a correctness one. The set is bounded
 * by the doc manager's LRU cap, so this is a handful of ids, not the vault.
 */
export function bodyPullTargets(
  changedNoteIds: readonly string[],
  openNoteIds: readonly string[]
): string[] {
  return [...new Set([...changedNoteIds, ...openNoteIds])]
}
