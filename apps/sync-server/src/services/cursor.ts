/**
 * Reserves `count` server cursors for one user inside the D1 batch that
 * commits the rows carrying them (#2282).
 *
 * D1 runs one batch as one transaction on a single writer, so the sequence
 * bump and the rows commit together: no reader can see a cursor above a range
 * whose rows have not committed yet. Reserving in a separate batch reopened
 * exactly that window. Device X reserved [10..12], device Y reserved [13] and
 * committed first, and every reader paging `server_cursor > ?` past 13 skipped
 * 10..12 for good.
 *
 * Row `position` (0-based, in batch order) gets cursor `top - (count - 1 - position)`.
 */
export interface CursorReservation {
  /** SQL expression for a row's cursor. Bind `cursorBinds(position)` in its place. */
  cursorSql: string
  cursorBinds(position: number): [string, number]
  /** The whole batch: the reservation first, then `writes`. */
  batch(writes: D1PreparedStatement[]): D1PreparedStatement[]
  /** The cursor row `position` got, read from the results of `batch`. */
  cursorAt(results: D1Result[], position: number): number
}

export const reserveCursors = (
  db: D1Database,
  userId: string,
  count: number
): CursorReservation => {
  if (count < 1) {
    throw new Error(`reserveCursors requires count >= 1, got ${count}`)
  }
  const offsetFromTop = (position: number): number => count - 1 - position
  const reservation = [
    db
      .prepare(
        'INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING'
      )
      .bind(userId),
    db
      .prepare(
        'UPDATE server_cursor_sequence SET current_cursor = current_cursor + ? WHERE user_id = ? RETURNING current_cursor'
      )
      .bind(count, userId)
  ]
  return {
    cursorSql: '(SELECT current_cursor FROM server_cursor_sequence WHERE user_id = ?) - ?',
    cursorBinds: (position) => [userId, offsetFromTop(position)],
    batch: (writes) => [...reservation, ...writes],
    cursorAt: (results, position) =>
      (results[1].results as Array<{ current_cursor: number }>)[0].current_cursor -
      offsetFromTop(position)
  }
}
