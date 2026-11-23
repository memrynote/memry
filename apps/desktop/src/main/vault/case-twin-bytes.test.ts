/**
 * The persisted case-twin hold state (#5522, #5560) on any file system: the
 * `sync_state` shapes a restart reads back, and what a reader does with a value
 * it does not understand. The macOS flows live in `case-twins-binary.test.ts`.
 *
 * @module vault/case-twin-bytes.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'
import {
  changedSinceMarked,
  clearCaseTwinForeignBytes,
  holdCaseTwinForeignChange,
  holdsCaseTwinForeignBytes,
  markCaseTwinForeignBytes,
  readCaseTwinForeignBytes,
  recordHeldCaseTwinChange,
  takeHeldCaseTwinChange
} from './case-twin-bytes'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }))
vi.mock('../lib/logger', () => ({ createLogger: () => log }))

describe('case twin hold state', () => {
  let t: TestDatabaseResult
  let dir: string
  const db = () => asClientDb(t.db)
  const stored = (key: string) =>
    (
      t.sqlite.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value
  const store = (key: string, value: string) =>
    t.sqlite
      .prepare('INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, value, Date.now())

  beforeEach(() => {
    t = createTestDataDb()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'case-twin-bytes-'))
    log.warn.mockClear()
  })
  afterEach(() => {
    t.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('a held change is kept under its folded path until taken once', () => {
    recordHeldCaseTwinChange(db(), 'Supernotes/p.png')
    recordHeldCaseTwinChange(db(), 'SUPERNOTES/P.png')

    expect(JSON.parse(stored(SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES)!)).toHaveLength(1)
    expect(takeHeldCaseTwinChange(db(), 'supernotes/p.PNG')).toBe(true)
    expect(takeHeldCaseTwinChange(db(), 'Supernotes/p.png')).toBe(false)
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_HELD_CHANGES)).toBeUndefined()
  })

  it('a mark stores the file fingerprint, and a change to the file nulls it until cleared', () => {
    const file = path.join(dir, 'p.png')
    fs.writeFileSync(file, 'abc')
    markCaseTwinForeignBytes(db(), 'twin-a', file, false)

    const { size } = fs.statSync(file)
    expect(JSON.parse(stored(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)!)).toEqual({
      'twin-a': { size, mtimeMs: fs.statSync(file).mtimeMs }
    })
    expect(changedSinceMarked(readCaseTwinForeignBytes(db()).get('twin-a')!, file)).toBe(false)
    fs.writeFileSync(file, 'abcd')
    expect(changedSinceMarked(readCaseTwinForeignBytes(db()).get('twin-a')!, file)).toBe(true)

    expect(holdCaseTwinForeignChange(db(), 'twin-a')).toBe(true)
    expect(readCaseTwinForeignBytes(db()).get('twin-a')).toBeNull()
    markCaseTwinForeignBytes(db(), 'twin-a', file, false)
    expect(readCaseTwinForeignBytes(db()).get('twin-a')).toBeNull()
    expect(holdCaseTwinForeignChange(db(), 'twin-b')).toBe(false)

    clearCaseTwinForeignBytes(db(), 'twin-a')
    expect(holdsCaseTwinForeignBytes(db(), 'twin-a')).toBe(false)
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)).toBeUndefined()
  })

  it('a missing file holds no change to keep', () => {
    expect(changedSinceMarked(null, path.join(dir, 'gone.png'))).toBe(false)
  })

  it('a foreign bytes value that is not an object reads as empty with a warn', () => {
    store(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES, JSON.stringify(['twin-a']))

    expect(readCaseTwinForeignBytes(db()).size).toBe(0)
    expect(log.warn).toHaveBeenCalledWith(
      'Case twin foreign bytes are not an object; reading them as empty',
      { type: 'array' }
    )
  })
})
