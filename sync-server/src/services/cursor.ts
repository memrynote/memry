export const getNextCursor = async (db: D1Database, userId: string): Promise<number> => {
  const result = await db
    .prepare(
      'UPDATE server_cursor_sequence SET current_cursor = current_cursor + 1 WHERE user_id = ? RETURNING current_cursor'
    )
    .bind(userId)
    .first<{ current_cursor: number }>()

  if (result) {
    return result.current_cursor
  }

  await db
    .prepare('INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 1)')
    .bind(userId)
    .run()

  return 1
}
