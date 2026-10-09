import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TestDatabaseResult, TestDb } from '@tests/utils/test-db'
import { createTestIndexDb } from '@tests/utils/test-db'
import {
  setNoteProperties,
  getNoteProperties,
  getPropertyType,
  insertPropertyDefinition
} from './property-queries'
import { insertNoteCache } from './note-crud'
import { extractProperties, parseNote } from '../../../vault/frontmatter'
import { inferPropertyType } from '../../../vault/property-type'

describe('project property typing', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const createNote = (id: string) =>
    insertNoteCache(db, {
      id,
      path: `notes/${id}.md`,
      title: `Note ${id}`,
      emoji: null,
      contentHash: `hash-${id}`,
      wordCount: 10,
      characterCount: 100,
      date: null,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('types the reserved project key as project and keeps the array', () => {
    createNote('note-1')
    setNoteProperties(db, 'note-1', { project: ['Alpha', 'Beta'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    const props = getNoteProperties(db, 'note-1')

    expect(props).toEqual([{ name: 'project', type: 'project', value: ['Alpha', 'Beta'] }])
  })

  it('keeps a single project as a one-element array', () => {
    createNote('note-2')
    setNoteProperties(db, 'note-2', { project: ['Alpha'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-2')[0].value).toEqual(['Alpha'])
  })

  it('reads an empty project list back as an empty array', () => {
    createNote('note-3')
    setNoteProperties(db, 'note-3', { project: [] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-3')[0].value).toEqual([])
  })

  it('still infers a non-reserved array key as text', () => {
    createNote('note-4')
    setNoteProperties(db, 'note-4', { colours: ['red'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-4')[0].type).toBe('text')
  })

  it('overrides a stale text definition already stored for the reserved project key', () => {
    // Simulates a vault indexed before this feature existed (e.g. imported from
    // Obsidian): a `project` definition row already exists with the old `text`
    // type. getPropertyType must resolve the reserved key first, not read this
    // stale row.
    insertPropertyDefinition(db, {
      name: 'project',
      type: 'text',
      options: null,
      defaultValue: null,
      color: null
    })
    createNote('note-5')

    setNoteProperties(db, 'note-5', { project: ['Alpha'] }, (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )

    expect(getNoteProperties(db, 'note-5')).toEqual([
      { name: 'project', type: 'project', value: ['Alpha'] }
    ])
  })
})

describe('unquoted YAML date typing (BBF-43)', () => {
  let dbResult: TestDatabaseResult
  let db: TestDb

  const indexFile = (id: string, file: string) => {
    insertNoteCache(db, {
      id,
      path: `notes/${id}.md`,
      title: id,
      emoji: null,
      contentHash: `hash-${id}`,
      wordCount: 1,
      characterCount: 1,
      date: null,
      createdAt: '2026-01-10T00:00:00.000Z',
      modifiedAt: '2026-01-12T00:00:00.000Z'
    })
    const { frontmatter } = parseNote(file, `notes/${id}.md`)
    setNoteProperties(db, id, extractProperties(frontmatter), (name, value) =>
      getPropertyType(db, name, value, inferPropertyType)
    )
    return getNoteProperties(db, id)
  }

  beforeEach(() => {
    dbResult = createTestIndexDb()
    db = dbResult.db
  })

  afterEach(() => {
    dbResult.close()
  })

  it('indexes unquoted dates exactly as the same dates quoted', () => {
    const unquoted = indexFile(
      'unquoted',
      '---\ndue: 2026-10-07\nat: 2026-09-01T08:30:00.000Z\n---\n'
    )
    const quoted = indexFile(
      'quoted',
      "---\ndue: '2026-10-07'\nat: '2026-09-01T08:30:00.000Z'\n---\n"
    )

    expect(unquoted).toEqual([
      { name: 'due', value: '2026-10-07', type: 'date' },
      { name: 'at', value: '2026-09-01T08:30:00.000Z', type: 'date' }
    ])
    expect(quoted).toEqual(unquoted)
  })

  it('does not let a text definition learned from an unquoted date pin text', () => {
    insertPropertyDefinition(db, {
      name: 'due',
      type: 'text',
      options: null,
      defaultValue: null,
      color: null
    })

    expect(indexFile('note-1', '---\ndue: 2026-10-07\n---\n')).toEqual([
      { name: 'due', value: '2026-10-07', type: 'date' }
    ])
  })

  it('keeps a definition the user chose over a non-text type', () => {
    insertPropertyDefinition(db, {
      name: 'due',
      type: 'select',
      options: null,
      defaultValue: null,
      color: null
    })

    expect(indexFile('note-1', '---\ndue: 2026-10-07\n---\n')).toEqual([
      { name: 'due', value: '2026-10-07', type: 'select' }
    ])
  })
})
