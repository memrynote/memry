export const getNextCursor = async (db: D1Database, userId: string): Promise<number> => {
  await db
    .prepare(
      'INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING'
    )
    .bind(userId)
    .run()

  const result = await db
    .prepare(
      'UPDATE server_cursor_sequence SET current_cursor = current_cursor + 1 WHERE user_id = ? RETURNING current_cursor'
    )
    .bind(userId)
    .first<{ current_cursor: number }>()

  return result!.current_cursor
}
