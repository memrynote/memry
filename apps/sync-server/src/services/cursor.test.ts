import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { reserveCursors } from './cursor'

let harness: SqliteD1

beforeEach(() => {
  harness = createSqliteD1()
  for (const id of ['user-1', 'user-2']) {
    harness.raw
      .prepare(
        `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
         VALUES (?, ?, 1, 'otp', 0, 0, 0, 0)`
      )
      .run(id, `${id}@example.com`)
  }
})

afterEach(() => {
  harness.close()
})

const reserve = async (userId: string, count: number): Promise<number[]> => {
  const cursors = reserveCursors(harness.db, userId, count)
  const results = await harness.db.batch(cursors.batch([]))
  return Array.from({ length: count }, (_, position) => cursors.cursorAt(results, position))
}

describe('reserveCursors', () => {
  it('starts a new user at 1 and hands out contiguous ranges in position order', async () => {
    expect(await reserve('user-1', 3)).toEqual([1, 2, 3])
    expect(await reserve('user-1', 1)).toEqual([4])
    expect(await reserve('user-2', 2)).toEqual([1, 2])
  })

  it('lets a write in the same batch read the cursor its position gets', async () => {
    const cursors = reserveCursors(harness.db, 'user-1', 3)
    const reads = [0, 1, 2].map((position) =>
      harness.db
        .prepare(`SELECT ${cursors.cursorSql} AS cursor`)
        .bind(...cursors.cursorBinds(position))
    )

    const results = await harness.db.batch(cursors.batch(reads))

    expect(
      results.slice(2).map((result) => (result.results as Array<{ cursor: number }>)[0].cursor)
    ).toEqual([0, 1, 2].map((position) => cursors.cursorAt(results, position)))
    expect(cursors.cursorAt(results, 2)).toBe(3)
  })

  it('refuses a zero or negative count instead of corrupting the sequence', () => {
    expect(() => reserveCursors(harness.db, 'user-1', 0)).toThrow('count >= 1')
    expect(() => reserveCursors(harness.db, 'user-1', -3)).toThrow('count >= 1')
  })
})
