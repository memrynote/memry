import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import { insertNoteCache } from './note-crud'
import {
  ensurePropertyDefinition,
  getNoteProperties,
  getNotePropertiesAsRecord,
  getPropertyDefinition,
  getPropertyType,
  setNoteProperties
} from './property-queries'
import { inferPropertyType } from '../../../vault/frontmatter'
import {
  setPropertyRefs,
  getPropertyRefsForNote,
  getIncomingPropertyRefs
} from './property-ref-queries'

describe('property refs', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const insertTestNote = (database: TestDb, id: string): void => {
    insertNoteCache(database, {
      id,
      path: `notes/${id}.md`,
      title: id,
      contentHash: `hash-${id}`,
      wordCount: 0,
      characterCount: 0,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('writes one row per parsed URI', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', {
      father: ['memry://note/nte_dad'],
      attendees: ['memry://task/tsk_1', 'memry://event/evt_2'],
      email: 'john@doe.com'
    })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(3)
    expect(rows.filter((r) => r.propertyName === 'father')).toEqual([
      {
        sourceNoteId: 'nte_source',
        propertyName: 'father',
        targetType: 'note',
        targetId: 'nte_dad'
      }
    ])
  })

  it('ignores non-relation values', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { tags: ['a', 'b'], mixed: ['memry://note/nte_1', 'x'] })
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(0)
  })

  it('replaces previous rows wholesale', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_old'] })
    setPropertyRefs(db, 'nte_source', { father: ['memry://note/nte_new'] })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(1)
    expect(rows[0].targetId).toBe('nte_new')
  })

  it('finds incoming refs by target', () => {
    insertTestNote(db, 'nte_a')
    insertTestNote(db, 'nte_b')
    setPropertyRefs(db, 'nte_a', { father: ['memry://note/nte_dad'] })
    setPropertyRefs(db, 'nte_b', { father: ['memry://note/nte_dad'] })

    const incoming = getIncomingPropertyRefs(db, 'note', 'nte_dad')
    expect(incoming.map((r) => r.sourceNoteId).sort()).toEqual(['nte_a', 'nte_b'])
  })

  // Production wiring: note-derived-state-projector.ts passes
  // `getPropertyType(db, name, value, inferPropertyType)`, not `inferPropertyType`
  // on its own. Passing the raw inference function here would exercise a path the
  // app never takes and hide anything the stored-definition lookup gets wrong.
  const productionGetType = (name: string, value: unknown) =>
    getPropertyType(db, name, value, inferPropertyType)

  it('is populated through setNoteProperties', () => {
    insertTestNote(db, 'nte_source')
    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, productionGetType)
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)
  })

  it('clears refs through setNoteProperties when properties become empty', () => {
    insertTestNote(db, 'nte_source')

    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, productionGetType)
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)

    setNoteProperties(db, 'nte_source', {}, productionGetType)
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(0)
  })

  it('de-duplicates a repeated URI within one property', () => {
    insertTestNote(db, 'nte_source')
    setPropertyRefs(db, 'nte_source', {
      attendees: ['memry://task/tsk_1', 'memry://task/tsk_1']
    })

    const rows = getPropertyRefsForNote(db, 'nte_source')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      sourceNoteId: 'nte_source',
      propertyName: 'attendees',
      targetType: 'task',
      targetId: 'tsk_1'
    })
  })
})

// Reproduces the sequence a user actually performs in the UI, at the seam where
// it used to break. `usePropertySection.handleAddProperty` seeds a new Relation
// with `getDefaultValueForType('relation')` — `[]` — and no type crosses IPC, so
// the very first thing the projector indexes for that property is an empty
// array. `isRelationValue([])` is false, so the type had to come from somewhere
// that does not depend on the value being populated.
describe('relation property added through the UI', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const productionGetType = (name: string, value: unknown) =>
    getPropertyType(db, name, value, inferPropertyType)

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
    insertNoteCache(db, {
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
    dbResult.close()
  })

  it('survives the add → pick → reopen → edit-another-property sequence', () => {
    // 1. Add the property. Default value is the empty array.
    setNoteProperties(db, 'nte_source', { father: [] }, productionGetType)

    // The empty array pins the definition row to `text` — nothing can infer
    // `relation` from `[]`. This is the state the fix has to survive, not avoid.
    expect(getPropertyDefinition(db, 'father')?.type).toBe('text')

    // 2. Pick a target.
    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, productionGetType)

    // 3. Reopen the note: this is what `properties:get` hands the renderer.
    const afterReopen = getNoteProperties(db, 'nte_source')
    expect(afterReopen).toHaveLength(1)
    expect(afterReopen[0].type).toBe('relation')
    expect(afterReopen[0].value).toEqual(['memry://note/nte_dad'])
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)

    // 4. Edit a different property. `use-properties.ts` rebuilds the whole
    //    record from the values it read back, so a flattened relation would be
    //    written straight to YAML here and its refs deleted.
    const rebuilt = { ...getNotePropertiesAsRecord(db, 'nte_source'), status: 'Done' }
    expect(rebuilt.father).toEqual(['memry://note/nte_dad'])
    setNoteProperties(db, 'nte_source', rebuilt, productionGetType)

    const afterEdit = getNoteProperties(db, 'nte_source')
    expect(afterEdit.find((p) => p.name === 'father')?.type).toBe('relation')
    expect(afterEdit.find((p) => p.name === 'father')?.value).toEqual(['memry://note/nte_dad'])
    expect(getPropertyRefsForNote(db, 'nte_source')).toEqual([
      {
        sourceNoteId: 'nte_source',
        propertyName: 'father',
        targetType: 'note',
        targetId: 'nte_dad'
      }
    ])
  })

  it('self-heals a note whose definition row was already pinned to text', () => {
    // A note damaged before the fix: definition says `text`, YAML array intact.
    ensurePropertyDefinition(db, 'father', 'text')
    expect(getPropertyDefinition(db, 'father')?.type).toBe('text')

    setNoteProperties(db, 'nte_source', { father: ['memry://note/nte_dad'] }, productionGetType)

    expect(getNoteProperties(db, 'nte_source')[0].type).toBe('relation')
    expect(getPropertyRefsForNote(db, 'nte_source')).toHaveLength(1)
  })
})
