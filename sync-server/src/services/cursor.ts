export const getNextCursor = async (db: D1Database, userId: string): Promise<number> => {
  const [, updateResult] = await db.batch([
    db
      .prepare(
        'INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING'
      )
      .bind(userId),
    db
      .prepare(
        'UPDATE server_cursor_sequence SET current_cursor = current_cursor + 1 WHERE user_id = ? RETURNING current_cursor'
      )
      .bind(userId)
  ])

  const row = (updateResult.results as Array<{ current_cursor: number }>)[0]
  return row.current_cursor
}
