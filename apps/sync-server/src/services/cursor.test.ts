import { describe, expect, it, vi } from 'vitest'

import { allocateCursorRange } from './cursor'

const createBatchDb = (currentCursorAfterUpdate: number) => {
  const insertStatement = {
    bind: vi.fn().mockReturnThis()
  }
  const updateStatement = {
    bind: vi.fn().mockReturnThis()
  }

  const prepare = vi.fn().mockReturnValueOnce(insertStatement).mockReturnValueOnce(updateStatement)

  const batch = vi.fn(async () => [
    { success: true, results: [] },
    { success: true, results: [{ current_cursor: currentCursorAfterUpdate }] }
  ])

  return {
    db: { prepare, batch } as unknown as D1Database,
    prepare,
    batch,
    insertStatement,
    updateStatement
  }
}

describe('cursor service', () => {
  it('reserves a contiguous range with one atomic insert + update batch', async () => {
    const { db, prepare, batch, insertStatement, updateStatement } = createBatchDb(50)

    const range = await allocateCursorRange(db, 'user-1', 9)

    expect(range).toEqual({ first: 42, last: 50 })
    expect(batch).toHaveBeenCalledWith([insertStatement, updateStatement])
    expect(prepare).toHaveBeenNthCalledWith(
      1,
      'INSERT INTO server_cursor_sequence (user_id, current_cursor) VALUES (?, 0) ON CONFLICT (user_id) DO NOTHING'
    )
    expect(prepare).toHaveBeenNthCalledWith(
      2,
      'UPDATE server_cursor_sequence SET current_cursor = current_cursor + ? WHERE user_id = ? RETURNING current_cursor'
    )
    expect(insertStatement.bind).toHaveBeenCalledWith('user-1')
    expect(updateStatement.bind).toHaveBeenCalledWith(9, 'user-1')
  })

  it('collapses to the single-cursor shape for a range of one', async () => {
    const { db, updateStatement } = createBatchDb(42)

    const range = await allocateCursorRange(db, 'user-1', 1)

    expect(range).toEqual({ first: 42, last: 42 })
    expect(updateStatement.bind).toHaveBeenCalledWith(1, 'user-1')
  })

  it('refuses a zero or negative count instead of corrupting the sequence', async () => {
    const { db, batch } = createBatchDb(42)

    await expect(allocateCursorRange(db, 'user-1', 0)).rejects.toThrow('count >= 1')
    await expect(allocateCursorRange(db, 'user-1', -3)).rejects.toThrow('count >= 1')
    expect(batch).not.toHaveBeenCalled()
  })
})
