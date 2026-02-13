import { describe, expect, it, vi } from 'vitest'

import { getNextCursor } from './cursor'

describe('cursor service', () => {
  it('batches insert + update and returns incremented cursor', async () => {
    const insertStatement = {
      bind: vi.fn().mockReturnThis()
    }
    const updateStatement = {
      bind: vi.fn().mockReturnThis()
    }

    const prepare = vi
      .fn()
      .mockReturnValueOnce(insertStatement)
      .mockReturnValueOnce(updateStatement)

    const batch = vi.fn(async () => [
      { success: true, results: [] },
      { success: true, results: [{ current_cursor: 42 }] }
    ])

    const db = { prepare, batch } as unknown as D1Database

    const cursor = await getNextCursor(db, 'user-1')

    expect(cursor).toBe(42)
    expect(batch).toHaveBeenCalledWith([insertStatement, updateStatement])
    expect(prepare).toHaveBeenNthCalledWith(
      1,
      'INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING'
    )
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      'UPDATE server_cursor_sequence SET current_cursor = current_cursor + 1 WHERE user_id = ? RETURNING current_cursor'
    )
  })
})
