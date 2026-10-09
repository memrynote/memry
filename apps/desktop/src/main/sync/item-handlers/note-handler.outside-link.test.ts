/**
 * A note file swapped for a symlink to a file outside the vault (#2804). The
 * sync apply and push paths refuse it the way `getNoteById` does (#2789): the
 * outside text never reaches the index, the vault or a push payload, and the
 * link is left as the user made it. Both databases and the vault are real.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'

const roots = vi.hoisted(() => ({ vault: '' }))

let dataDb: TestDatabaseResult
let indexDb: TestDatabaseResult

vi.mock('../../database', () => ({ getDatabase: () => dataDb.db }))

vi.mock('../../database/client', () => ({
  getDatabase: () => dataDb.db,
  getIndexDatabase: () => indexDb.db
}))

vi.mock('../../vault/notes', () => ({
  getVaultRoot: () => roots.vault,
  toRelativePath: (p: string) => path.relative(roots.vault, p),
  toAbsolutePath: (p: string) => path.join(roots.vault, p)
}))

vi.mock('../../vault/index', () => ({
  getStatus: () => ({ path: roots.vault })
}))

vi.mock('../crdt-writeback', () => ({ markWritebackIgnored: vi.fn() }))

import { noteHandler } from './note-handler'
import { buildNotePushPayload } from './note-handler-sync-helpers'
import { getNoteTags } from '@main/database/queries/notes'

const SECRET = '---\ntags: [outside-tag]\n---\nOutside secret #outside-body\n'
const LOCAL_CLOCK = { 'device-A': 1 }
const REMOTE_CLOCK = { 'device-A': 1, 'device-B': 1 }

describe('a synced note whose file links outside the vault', () => {
  let outside: string
  let secret: string
  let link: string
  let ctx: ApplyContext

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    ctx = { db: dataDb.db as unknown as DrizzleDb, emit: vi.fn() }
    roots.vault = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-outside-link-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'memry-note-outside-target-'))
    secret = path.join(outside, 'private.md')
    fs.writeFileSync(secret, SECRET)
    fs.mkdirSync(path.join(roots.vault, 'notes'))
    link = path.join(roots.vault, 'notes', 'n1.md')
    fs.symlinkSync(secret, link)

    const row = {
      id: 'n1',
      path: 'notes/n1.md',
      title: 'n1',
      fileType: 'markdown' as const,
      createdAt: '2026-01-01T00:00:00.000Z',
      modifiedAt: '2026-01-01T00:00:00.000Z'
    }
    dataDb.db
      .insert(noteMetadata)
      .values({ ...row, clock: LOCAL_CLOCK })
      .run()
    indexDb.db.insert(noteCache).values(row).run()
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
    fs.rmSync(roots.vault, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  function expectLinkUntouched(): void {
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET)
    expect(fs.readdirSync(path.join(roots.vault, 'notes'))).toEqual(['n1.md'])
  }

  it('applies a remote tags and properties update without reading the linked file', () => {
    const result = noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'n1', tags: ['remote'], properties: { status: 'done' }, clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    expect(result).toBe('applied')
    expect(getNoteTags(indexDb.db, 'n1')).toEqual(['remote'])
    expectLinkUntouched()
  })

  it('applies a remote rename without reading the linked file', () => {
    noteHandler.applyUpsert(
      ctx,
      'n1',
      { title: 'Renamed', tags: ['remote'], clock: REMOTE_CLOCK },
      REMOTE_CLOCK
    )

    const files = fs.readdirSync(roots.vault, { recursive: true, encoding: 'utf-8' })
    for (const name of files.filter((file) => file.endsWith('.md'))) {
      const file = path.join(roots.vault, name)
      if (fs.lstatSync(file).isSymbolicLink()) continue
      expect(fs.readFileSync(file, 'utf-8')).not.toContain('Outside secret')
    }
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET)
  })

  it('pushes neither the linked text nor its tags', () => {
    const payload = JSON.parse(buildNotePushPayload('n1', 'create') ?? '{}')

    expect(payload.content).toBeNull()
    expect(payload.tags).toEqual([])
    expect(JSON.stringify(payload)).not.toContain('outside')
  })
})
