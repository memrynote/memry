export interface CursorRange {
  first: number
  last: number
}

/**
 * Reserves `count` strictly monotonic server cursors for one user in a single
 * atomic D1 round trip.
 *
 * The whole reservation is ONE `UPDATE ... RETURNING` on the user's
 * `server_cursor_sequence` row, so two devices pushing concurrently each get a
 * disjoint contiguous range: D1 serializes the row update, and the returned
 * value is the top of the range this caller (and nobody else) advanced the
 * sequence by. Per-user monotonicity — which pull ordering depends on — is
 * therefore exactly what the old one-cursor-per-call code guaranteed, at one
 * D1 batch per push batch instead of one per item.
 *
 * A caller that ends up not using part of its range (an item rejected after
 * allocation) leaves a gap in the sequence. Gaps are harmless: cursors are an
 * ordering token, and every reader pages with `server_cursor > ?`.
 */
export const allocateCursorRange = async (
  db: D1Database,
  userId: string,
  count: number
): Promise<CursorRange> => {
  if (count < 1) {
    throw new Error(`allocateCursorRange requires count >= 1, got ${count}`)
  }

  const [, updateResult] = await db.batch([
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
  ])

  const row = (updateResult.results as Array<{ current_cursor: number }>)[0]
  return { first: row.current_cursor - count + 1, last: row.current_cursor }
}
