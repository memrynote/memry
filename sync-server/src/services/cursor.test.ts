import { describe, expect, it, vi } from 'vitest'

import { getNextCursor } from './cursor'

describe('cursor service', () => {
  it('inserts sequence row if needed and returns incremented cursor', async () => {
    const initRun = vi.fn(async () => ({ success: true }))
    const incrementFirst = vi.fn(async () => ({ current_cursor: 42 }))

    const firstStatement = {
      bind: vi.fn(() => ({ run: initRun }))
    }
    const secondStatement = {
      bind: vi.fn(() => ({ first: incrementFirst }))
    }

    const prepare = vi.fn().mockReturnValueOnce(firstStatement).mockReturnValueOnce(secondStatement)

    const db = { prepare } as unknown as D1Database

    const cursor = await getNextCursor(db, 'user-1')

    expect(cursor).toBe(42)
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
