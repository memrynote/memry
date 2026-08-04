import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asClientDb, createTestDataDb, createTestIndexDb } from '@tests/utils/test-db'
import type { TestDatabaseResult } from '@tests/utils/test-db'
import { getPropertyDefinition as getCanonicalPropertyDefinition } from '@memry/storage-data'
import { getNoteProperties, insertNoteCache, setNoteProperties } from '@main/database/queries/notes'
import { getPropertyRefsForNote } from '@main/database/queries/notes/property-ref-queries'
import { resolveSyncPropertyType } from './note-property-type'

// The sync-UPDATE path. `noteHandler.applyUpsert` writes index rows through this
// resolver against the canonical (data DB) definition store, and the file it
// writes is marked `markWritebackIgnored` — so the note projector, and the
// structural override in `getPropertyType` that covers it, never revisit this
// note. Everything here runs the real resolver against real databases; only the
// surrounding handler I/O is out of frame.
describe('resolveSyncPropertyType', () => {
  let dataResult: TestDatabaseResult
  let indexResult: TestDatabaseResult

  const resolve = (name: string, value: unknown) =>
    resolveSyncPropertyType(asClientDb(dataResult.db), name, value)

  beforeEach(() => {
    dataResult = createTestDataDb()
    indexResult = createTestIndexDb()
    insertNoteCache(indexResult.db, {
      id: 'nte_source',
      path: 'notes/nte_source.md',
      title: 'Source',
      contentHash: 'hash-source',
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  })

  afterEach(() => {
    dataResult.close()
    indexResult.close()
  })

  it('survives a relation whose empty first write pinned the definition to text', () => {
    // 1. The originating device's add syncs over as `father: []`. Nothing can
    //    infer `relation` from an empty array, so the canonical definition is
    //    pinned to `text` here — the state the fix has to survive, not avoid.
    setNoteProperties(indexResult.db, 'nte_source', { father: [] }, resolve)
    expect(getCanonicalPropertyDefinition(asClientDb(dataResult.db), 'father')?.type).toBe('text')

    // 2. A later sync update carries the populated value.
    setNoteProperties(indexResult.db, 'nte_source', { father: ['memry://note/nte_dad'] }, resolve)

    // Typed from the value, not from the poisoned definition. A `text` row here
    // would make `deserializeValue` return the raw JSON string, and both push
    // builders read properties straight out of this table.
    const stored = getNoteProperties(indexResult.db, 'nte_source')
    expect(stored).toHaveLength(1)
    expect(stored[0].type).toBe('relation')
    expect(stored[0].value).toEqual(['memry://note/nte_dad'])
    expect(getPropertyRefsForNote(indexResult.db, 'nte_source')).toHaveLength(1)
  })

  it('never writes relation into the canonical definition store', () => {
    resolve('father', ['memry://note/nte_dad'])

    // PropertyDefinitionSchema has no `relation` member — a definition row
    // carrying it would make `.memry/properties.md` fail to parse and drop every
    // definition in the file. The relation is typed from its value instead.
    expect(getCanonicalPropertyDefinition(asClientDb(dataResult.db), 'father')).toBeUndefined()
  })

  it('still defers to the canonical definition for non-relation values', () => {
    expect(resolve('Rating', 5)).toBe('number')
    expect(getCanonicalPropertyDefinition(asClientDb(dataResult.db), 'Rating')?.type).toBe('number')

    // An established definition keeps winning over inference, as before.
    expect(resolve('Rating', 'five')).toBe('number')
  })
})
