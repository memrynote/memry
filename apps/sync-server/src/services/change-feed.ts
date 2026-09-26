/**
 * One page of GET /sync/changes across the tables that carry a server_cursor
 * (#2295): sync_items, and, when the client declared `note_body`,
 * crdt_updates and crdt_snapshots.
 *
 * Every row of every source lies in the page's closed interval
 * (cursor, nextCursor]. A row inside that interval missing from the page is
 * skipped forever, because the client stores nextCursor after applying.
 */

/**
 * One row a source read. `value: null` is a row the page must not serve whose
 * cursor still counts, so a filtered row never opens a gap the next page skips.
 */
export interface FeedRow<T> {
  cursor: number
  value: T | null
}

/**
 * One source's read: rows with `server_cursor > after`, ascending, at most
 * `fetchLimit` of them. `fetchLimit` is always supplied by `readChangePage`.
 */
export interface FeedSource<T> {
  statement: D1PreparedStatement
  parse(rows: unknown[]): FeedRow<T>[]
}

export type FeedSourceBuilder<T> = (after: number, fetchLimit: number) => FeedSource<T>

export interface ChangePage<T> {
  entries: T[]
  hasMore: boolean
  nextCursor: number
}

/**
 * Merge the sources' rows ascending by cursor (unique per user: one sequence)
 * and take the first `limit`. Exact because every source returned up to
 * `limit + 1` rows: a truncated source has already returned more rows than a
 * page can hold, so no row it did not return can rank inside the page.
 */
export const closeChangePage = <T>(
  slices: FeedRow<T>[][],
  after: number,
  limit: number
): ChangePage<T> => {
  const merged = slices.flat().sort((a, b) => a.cursor - b.cursor)
  const taken = merged.slice(0, limit)
  return {
    entries: taken.flatMap((row) => (row.value === null ? [] : [row.value])),
    hasMore: merged.length > taken.length,
    nextCursor: taken.length > 0 ? taken[taken.length - 1].cursor : after
  }
}

/**
 * Read one page. Two or more sources go in ONE db.batch, which D1 runs as one
 * transaction. Separate reads would let a write commit between them: read
 * sync_items, then a record commits at cursor 99, then crdt_updates returns
 * cursor 100, and nextCursor = 100 skips 99 forever.
 */
export const readChangePage = async <T>(
  db: D1Database,
  builders: FeedSourceBuilder<T>[],
  after: number,
  limit: number
): Promise<ChangePage<T>> => {
  const sources = builders.map((build) => build(after, limit + 1))
  const results =
    sources.length === 1
      ? [await sources[0].statement.all()]
      : await db.batch(sources.map((source) => source.statement))
  return closeChangePage(
    sources.map((source, index) => source.parse(results[index].results ?? [])),
    after,
    limit
  )
}
