/**
 * Which note bodies a pull pass has to fetch.
 *
 * Note bodies do not travel in the record change feed. The feed carries record
 * rows, and a body-only edit writes no record row at all, so the pass learns
 * about it from exactly two places: the `crdt_updated` socket broadcast, and
 * this set.
 */
export function bodyPullTargets(changedNoteIds: readonly string[]): string[] {
  return [...new Set(changedNoteIds)]
}
