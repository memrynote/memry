/**
 * The persisted case-twin hold state (#5522, #5560) on any file system: the
 * `sync_state` shapes a restart reads back, and what a reader does with a value
 * it does not understand. The macOS flows live in `case-twins-binary.test.ts`.
 *
 * @module vault/case-twin-bytes.test
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { SYNC_STATE_KEYS } from '../sync/engine/sync-context'
import {
  clearCaseTwinForeignBytes,
  hashFile,
  holdsCaseTwinForeignBytes,
  listCaseTwinForeignBytes,
  markCaseTwinForeignBytes,
  readCaseTwinForeignBytes,
  readKeptCaseTwinCopy,
  recordHeldCaseTwinChange,
  recordKeptCaseTwinCopy,
  recordLandedCaseTwinHash,
  takeHeldCaseTwinChange,
  takeLandedCaseTwinHash
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

  it('a landed hash is kept under its folded path until taken once', () => {
    recordLandedCaseTwinHash(db(), 'SUPERNOTES/p.png', 'h1')

    expect(JSON.parse(stored(SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES)!)).toEqual({
      'supernotes/p.png': 'h1'
    })
    expect(takeLandedCaseTwinHash(db(), 'Supernotes/p.png')).toBe('h1')
    expect(takeLandedCaseTwinHash(db(), 'Supernotes/p.png')).toBeUndefined()
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_LANDED_HASHES)).toBeUndefined()
  })

  it('a mark stores the file hash in its own row; a null mark stays null until cleared', () => {
    markCaseTwinForeignBytes(db(), 'twin-a', { sha256: 'h1' })
    expect(stored('caseTwinForeignBytes:twin-a')).toBe(JSON.stringify({ sha256: 'h1' }))

    markCaseTwinForeignBytes(db(), 'twin-b', null)
    markCaseTwinForeignBytes(db(), 'twin-b', { sha256: 'h2' })
    expect(readCaseTwinForeignBytes(db(), 'twin-b')).toBeNull()
    expect(stored('caseTwinForeignBytes:twin-a')).toBe(JSON.stringify({ sha256: 'h1' }))
    expect(listCaseTwinForeignBytes(db()).toSorted()).toEqual(['twin-a', 'twin-b'])

    clearCaseTwinForeignBytes(db(), 'twin-a')
    expect(holdsCaseTwinForeignBytes(db(), 'twin-a')).toBe(false)
    expect(listCaseTwinForeignBytes(db())).toEqual(['twin-b'])
    clearCaseTwinForeignBytes(db(), 'twin-b')
    expect(listCaseTwinForeignBytes(db())).toEqual([])
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)).toBeUndefined()
  })

  it("moves an older build's marks from their one object to their own rows", () => {
    store(
      SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES,
      JSON.stringify({ 'twin-a': { sha256: 'h1' }, 'twin-b': null, 'twin-c': { sha256: 'old' } })
    )
    store('caseTwinForeignBytes:twin-c', JSON.stringify({ sha256: 'new' }))

    expect(readCaseTwinForeignBytes(db(), 'twin-a')).toEqual({ sha256: 'h1' })
    expect(readCaseTwinForeignBytes(db(), 'twin-b')).toBeNull()
    expect(readCaseTwinForeignBytes(db(), 'twin-c')).toEqual({ sha256: 'new' })
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)).toBeUndefined()
    expect(stored('caseTwinForeignBytes:twin-a')).toBe(JSON.stringify({ sha256: 'h1' }))
  })

  it('a mark in the unshipped size and mtime shape reads as a change to keep', () => {
    store(
      SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES,
      JSON.stringify({ 'twin-a': { size: 3, mtimeMs: 1 }, 'twin-b': 'junk' })
    )

    expect(listCaseTwinForeignBytes(db())).toEqual(['twin-a'])
    expect(readCaseTwinForeignBytes(db(), 'twin-a')).toBeNull()
  })

  it('a mark row it cannot read holds the file as changed', () => {
    store('caseTwinForeignBytes:twin-a', 'junk')

    expect(readCaseTwinForeignBytes(db(), 'twin-a')).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(
      'A case twin mark is unreadable; its file is held as changed',
      { noteId: 'twin-a' }
    )
  })

  it('kept bytes count as kept only while the copy named with them holds them', () => {
    const kept = createHash('sha256').update('edited').digest('hex')
    fs.writeFileSync(path.join(dir, 'p (conflict copy).png'), 'edited')
    recordKeptCaseTwinCopy(db(), 'SUPERNOTES/p.png', {
      sha256: kept,
      copy: 'p (conflict copy).png'
    })

    expect(JSON.parse(stored(SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES)!)).toEqual({
      'supernotes/p.png': { sha256: kept, copy: 'p (conflict copy).png' }
    })
    expect(readKeptCaseTwinCopy(db(), dir, 'Supernotes/p.png')).toBe(kept)
    fs.writeFileSync(path.join(dir, 'p (conflict copy).png'), 'changed')
    expect(readKeptCaseTwinCopy(db(), dir, 'Supernotes/p.png')).toBeUndefined()
    fs.rmSync(path.join(dir, 'p (conflict copy).png'))
    expect(readKeptCaseTwinCopy(db(), dir, 'Supernotes/p.png')).toBeUndefined()
    // VERIFY-5602R2 #5: a folder there cannot be read, and never fails the landing.
    fs.mkdirSync(path.join(dir, 'p (conflict copy).png'))
    expect(readKeptCaseTwinCopy(db(), dir, 'Supernotes/p.png')).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'A kept conflict copy cannot be read; its bytes count as not kept',
      expect.objectContaining({ copy: 'p (conflict copy).png' })
    )
  })

  it('a kept hash in the unreleased shape with no copy reads as not kept', () => {
    const kept = createHash('sha256').update('edited').digest('hex')
    fs.writeFileSync(path.join(dir, 'p (conflict copy).png'), 'edited')
    store(SYNC_STATE_KEYS.CASE_TWIN_KEPT_COPIES, JSON.stringify({ 'supernotes/p.png': kept }))

    expect(readKeptCaseTwinCopy(db(), dir, 'Supernotes/p.png')).toBeUndefined()
  })

  it('hashes a file larger than one read as the manifest checksum does, and a missing file as null', () => {
    const file = path.join(dir, 'big.bin')
    const bytes = Buffer.alloc(2.5 * 1024 * 1024, 7)
    bytes[bytes.length - 1] = 1
    fs.writeFileSync(file, bytes)

    expect(hashFile(file)).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(hashFile(path.join(dir, 'gone.bin'))).toBeNull()
  })

  it('a foreign bytes value that is not an object reads as empty with a warn', () => {
    store(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES, JSON.stringify(['twin-a']))

    expect(listCaseTwinForeignBytes(db())).toEqual([])
    expect(stored(SYNC_STATE_KEYS.CASE_TWIN_FOREIGN_BYTES)).toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith(
      'Case twin foreign bytes are not an object; reading them as empty',
      { type: 'array' }
    )
  })
})
