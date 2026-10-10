import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TagDefinitionSyncPayload } from '@memry/contracts/sync-payloads'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { noteCache } from '@memry/db-schema/schema/notes-cache'
import type { ApplyContext, DrizzleDb } from '@memry/sync-client/item-handlers/types'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  seedInboxProject,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { DataDb } from '../database/types'
import { getOrCreateTag } from '../database/queries/tag-definitions'
import { getAllTagsWithCounts } from '../database/queries/tags'
import { findNotesWithTagInfo, setNoteTags } from '../database/queries/notes'
import { getTaskTags, insertTask, listTasks, setTaskTags } from '../database/queries/tasks'

const sync = vi.hoisted(() => ({ deletes: [] as string[], updates: [] as string[] }))

vi.mock('./runtime-effects', () => ({
  syncTagDefinitionDelete: (row?: { name: string }) => row && sync.deletes.push(row.name),
  syncTagDefinitionUpdate: (tag: string) => sync.updates.push(tag)
}))
vi.mock('../lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })
}))

import { tagDefinitionHandler } from '../sync/item-handlers/tag-definition-handler'
import { convergeTagIdentity } from './converge-identity'

interface Device {
  data: TestDatabaseResult
  index: TestDatabaseResult
  db: DataDb
}

function device(): Device {
  const data = createTestDataDb()
  return { data, index: createTestIndexDb(), db: asClientDb(data.db) }
}

const ctx = (d: Device): ApplyContext => ({ db: d.data.db as unknown as DrizzleDb, emit: vi.fn() })

const names = (d: Device): string[] =>
  d.db
    .select({ name: tagDefinitions.name })
    .from(tagDefinitions)
    .all()
    .map((row) => row.name)
    .sort()

function payload(d: Device, name: string): TagDefinitionSyncPayload {
  const json = tagDefinitionHandler.buildPushPayload(
    d.data.db as unknown as DrizzleDb,
    name,
    'x',
    'create'
  )
  return JSON.parse(json!) as TagDefinitionSyncPayload
}

const stamp = {
  contentHash: 'h',
  createdAt: '2026-01-01T00:00:00.000Z',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  indexedAt: '2026-01-01T00:00:00.000Z'
}

describe('Unicode tag identity', () => {
  let a: Device
  let b: Device

  beforeEach(() => {
    sync.deletes = []
    sync.updates = []
    a = device()
    b = device()
  })

  afterEach(() => {
    for (const d of [a, b]) {
      d.data.close()
      d.index.close()
    }
  })

  it('finds a definition, notes and tasks by any spelling of a non-ASCII tag', () => {
    getOrCreateTag(a.db, 'Ünal')
    expect(getOrCreateTag(a.db, 'ünal').name).toBe('Ünal')
    expect(names(a)).toEqual(['Ünal'])

    a.index.db
      .insert(noteCache)
      .values({ id: 'n1', path: 'n1.md', title: 'N1', ...stamp })
      .run()
    a.index.db
      .insert(noteCache)
      .values({ id: 'n2', path: 'n2.md', title: 'N2', ...stamp })
      .run()
    setNoteTags(a.index.db, 'n1', { header: ['İş', 'iş', 'Ünal'], inline: [] })
    setNoteTags(a.index.db, 'n2', { header: ['ünal'], inline: [] })
    expect(
      findNotesWithTagInfo(a.index.db, 'ÜNAL')
        .map((n) => n.id)
        .sort()
    ).toEqual(['n1', 'n2'])
    expect(findNotesWithTagInfo(a.index.db, 'i\u0307ş').map((n) => n.id)).toEqual(['n1'])

    const project = seedInboxProject(a.data.db)
    insertTask(a.db, { id: 't1', projectId: project, title: 'T', position: 0 })
    setTaskTags(a.db, 't1', ['Şehir', 'şehir'])
    expect(getTaskTags(a.db, 't1')).toEqual(['Şehir'])
    expect(listTasks(a.db, { tags: ['ŞEHİR'] }).map((t) => t.id)).toEqual(['t1'])

    const listed = getAllTagsWithCounts(a.index.db, a.db)
    expect(listed.filter((t) => t.name.toLowerCase() === 'ünal')).toEqual([
      expect.objectContaining({ count: 2 })
    ])
  })

  it('merges definitions that are now one tag, and two devices converge on one id', () => {
    const schema = JSON.stringify({ t: 2, fields: [{ name: 'Role' }] })
    a.db
      .insert(tagDefinitions)
      .values({ name: 'Ünal', color: 'rose', schema, createdAt: '2026-01-02T00:00:00.000Z' })
      .run()
    b.db
      .insert(tagDefinitions)
      .values({
        name: 'ünal',
        color: 'sky',
        colorAuthored: true,
        icon: '👤',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      .run()

    // Each device receives the other's definition through the sync handler.
    tagDefinitionHandler.applyUpsert(ctx(a), 'ünal', payload(b, 'ünal'), { b: 1 })
    tagDefinitionHandler.applyUpsert(ctx(b), 'Ünal', payload(a, 'Ünal'), { a: 1 })
    expect(names(a)).toEqual(['Ünal', 'ünal'])

    convergeTagIdentity(a.db, a.index.db)
    convergeTagIdentity(b.db, b.index.db)

    // Same survivor on both: the higher schema version.
    for (const d of [a, b]) {
      expect(names(d)).toEqual(['Ünal'])
      expect(d.db.select().from(tagDefinitions).get()).toMatchObject({
        schema,
        icon: '👤',
        color: 'sky',
        colorAuthored: true
      })
    }
    expect(sync.deletes).toEqual(['ünal', 'ünal'])

    // A's tombstone reaching B is a no-op; a second open changes nothing.
    expect(tagDefinitionHandler.applyDelete(ctx(b), 'ünal')).toBe('skipped')
    sync.deletes = []
    expect(convergeTagIdentity(a.db, a.index.db)).toEqual({
      definitionsMerged: 0,
      usagesDropped: 0
    })
    expect(sync.deletes).toEqual([])
  })

  it('merges the old full-lowercase key of a dotted capital I into the folded one', () => {
    a.db
      .insert(tagDefinitions)
      .values([
        { name: 'i\u0307ş', color: 'rose', createdAt: '2026-01-01T00:00:00.000Z' },
        { name: 'iş', color: 'sky', createdAt: '2026-01-03T00:00:00.000Z' }
      ])
      .run()
    expect(convergeTagIdentity(a.db, a.index.db).definitionsMerged).toBe(1)
    expect(names(a)).toEqual(['i\u0307ş'])
    expect(getOrCreateTag(a.db, 'İş').name).toBe('i\u0307ş')
  })

  it('drops a second spelling of one tag on one task, keeping the first', () => {
    const project = seedInboxProject(a.data.db)
    insertTask(a.db, { id: 't1', projectId: project, title: 'T', position: 0 })
    // An older build's rows: NOCASE let both spellings in.
    a.data.sqlite.prepare("INSERT INTO task_tags (task_id, tag) VALUES ('t1', 'Ünal')").run()
    a.data.sqlite.prepare("INSERT INTO task_tags (task_id, tag) VALUES ('t1', 'ünal')").run()

    expect(convergeTagIdentity(a.db, a.index.db).usagesDropped).toBe(1)
    expect(getTaskTags(a.db, 't1')).toEqual(['Ünal'])
  })
})
