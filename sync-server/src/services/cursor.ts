/**
 * T033b: Atomic Server Cursor Increment
 *
 * Provides atomic cursor management for sync operations.
 * Uses D1 RETURNING clause for atomic increment and return.
 */

import { SyncError, ErrorCode } from '../lib/errors'

/**
 * Atomically increment and return the next server cursor for a user.
 * Uses INSERT ... ON CONFLICT and UPDATE ... RETURNING for atomic operation.
 *
 * @param db - D1 database instance
 * @param userId - The user ID to get cursor for
 * @returns The next cursor value (monotonically increasing)
 * @throws SyncError if database operation fails
 */
export const getNextCursor = async (db: D1Database, userId: string): Promise<number> => {
  try {
    // Ensure user has a cursor sequence entry
    await db
      .prepare(
        `
      INSERT INTO server_cursor_sequence (user_id, current_cursor)
      VALUES (?, 0)
      ON CONFLICT (user_id) DO NOTHING
    `
      )
      .bind(userId)
      .run()

    // Atomic increment and return
    const result = await db
      .prepare(
        `
      UPDATE server_cursor_sequence
      SET current_cursor = current_cursor + 1
      WHERE user_id = ?
      RETURNING current_cursor
    `
      )
      .bind(userId)
      .first<{ current_cursor: number }>()

    if (!result) {
      throw new SyncError(
        'Failed to generate cursor',
        ErrorCode.SERVER_DATABASE_ERROR,
        500
      )
    }

    return result.current_cursor
  } catch (error) {
    if (error instanceof SyncError) {
      throw error
    }
    throw new SyncError(
      'Database error during cursor increment',
      ErrorCode.SERVER_DATABASE_ERROR,
      500,
      { originalError: error instanceof Error ? error.message : String(error) }
    )
  }
}

/**
 * Get multiple next cursors atomically.
 * Useful for batch operations where multiple items need sequential cursors.
 *
 * @param db - D1 database instance
 * @param userId - The user ID to get cursors for
 * @param count - Number of cursors to allocate
 * @returns Array of cursor values in order
 */
export const getNextCursors = async (
  db: D1Database,
  userId: string,
  count: number
): Promise<number[]> => {
  if (count <= 0) {
    return []
  }

  try {
    // Ensure user has a cursor sequence entry
    await db
      .prepare(
        `
      INSERT INTO server_cursor_sequence (user_id, current_cursor)
      VALUES (?, 0)
      ON CONFLICT (user_id) DO NOTHING
    `
      )
      .bind(userId)
      .run()

    // Atomic increment by count and return new value
    const result = await db
      .prepare(
        `
      UPDATE server_cursor_sequence
      SET current_cursor = current_cursor + ?
      WHERE user_id = ?
      RETURNING current_cursor
    `
      )
      .bind(count, userId)
      .first<{ current_cursor: number }>()

    if (!result) {
      throw new SyncError(
        'Failed to generate cursors',
        ErrorCode.SERVER_DATABASE_ERROR,
        500
      )
    }

    // Generate array of cursors [newValue - count + 1, ..., newValue]
    const endCursor = result.current_cursor
    const startCursor = endCursor - count + 1
    const cursors: number[] = []
    for (let i = startCursor; i <= endCursor; i++) {
      cursors.push(i)
    }

    return cursors
  } catch (error) {
    if (error instanceof SyncError) {
      throw error
    }
    throw new SyncError(
      'Database error during cursor batch increment',
      ErrorCode.SERVER_DATABASE_ERROR,
      500,
      { originalError: error instanceof Error ? error.message : String(error) }
    )
  }
}

/**
 * Get current cursor without incrementing (for status queries).
 *
 * @param db - D1 database instance
 * @param userId - The user ID to get cursor for
 * @returns Current cursor value, or 0 if user has no cursor yet
 */
export const getCurrentCursor = async (db: D1Database, userId: string): Promise<number> => {
  try {
    const result = await db
      .prepare(`SELECT current_cursor FROM server_cursor_sequence WHERE user_id = ?`)
      .bind(userId)
      .first<{ current_cursor: number }>()

    return result?.current_cursor ?? 0
  } catch (error) {
    throw new SyncError(
      'Database error during cursor query',
      ErrorCode.SERVER_DATABASE_ERROR,
      500,
      { originalError: error instanceof Error ? error.message : String(error) }
    )
  }
}

/**
 * Validate that a client cursor is valid for the user.
 * A cursor is valid if it's less than or equal to the current server cursor.
 *
 * @param db - D1 database instance
 * @param userId - The user ID
 * @param clientCursor - The cursor value from the client
 * @returns True if cursor is valid
 */
export const validateCursor = async (
  db: D1Database,
  userId: string,
  clientCursor: number
): Promise<boolean> => {
  if (clientCursor < 0) {
    return false
  }

  const currentCursor = await getCurrentCursor(db, userId)
  return clientCursor <= currentCursor
}
