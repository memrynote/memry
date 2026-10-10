import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'

const state = vi.hoisted(() => ({ data: null as unknown, index: null as unknown }))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../database/client')>()),
  getDatabase: () => state.data,
  getIndexDatabase: () => state.index
}))

import { previewTagImpact } from './impact'

let data: TestDatabaseResult
let index: TestDatabaseResult

const impact = (query: Parameters<typeof previewTagImpact>[2]) =>
  previewTagImpact(asClientDb(data.db), index.db as never, query)

function defineTag(
  db: TestDb,
  name: string,
  schema: object | null,
  template?: { id: string; name: string }
): void {
  if (template) {
    db.run(sql`INSERT INTO templates (id, name) VALUES (${template.id}, ${template.name})`)
  }
  const body = schema === null ? null : JSON.stringify({ t: 1, ...schema })
  db.run(sql`INSERT INTO tag_definitions (name, color, schema) VALUES (${name}, 'blue', ${body})`)
}

interface NoteFixture {
  id: string
  tags?: Array<[tag: string, inHeader: boolean]>
  date?: string
  fileType?: 'markdown' | 'pdf'
  properties?: Array<[name: string, value: string]>
}

function insertNote(db: TestDb, note: NoteFixture): void {
  db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, date, content_hash, created_at, modified_at)
    VALUES (${note.id}, ${`notes/${note.id}.md`}, ${note.id}, ${note.fileType ?? 'markdown'},
            ${note.date ?? null}, ${'h-' + note.id}, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `)
  ;(note.tags ?? []).forEach(([tag, inHeader], position) => {
    db.run(sql`
      INSERT INTO note_tags (note_id, tag, position, in_header)
      VALUES (${note.id}, ${tag}, ${position}, ${Number(inHeader)})
    `)
  })
  for (const [name, value] of note.properties ?? []) {
    db.run(sql`
      INSERT INTO note_properties (note_id, name, value, type) VALUES (${note.id}, ${name}, ${value}, 'text')
    `)
  }
}

function insertTask(db: TestDb, id: string, tags: string[], fields: object | null): void {
  db.run(sql`INSERT INTO projects (id, name, is_inbox, position) VALUES ('inbox', 'Inbox', 1, 0)
             ON CONFLICT DO NOTHING`)
  db.run(sql`
    INSERT INTO tasks (id, project_id, title, position, fields)
    VALUES (${id}, 'inbox', ${'Task ' + id}, 0, ${fields === null ? null : JSON.stringify(fields)})
  `)
  for (const tag of tags) db.run(sql`INSERT INTO task_tags (task_id, tag) VALUES (${id}, ${tag})`)
}

beforeEach(() => {
  data = createTestDataDb()
  index = createTestIndexDb()
  state.data = data.db
  state.index = index.db

  defineTag(
    data.db,
    'person',
    {
      fields: [{ name: 'Role' }, { name: 'Phone' }],
      template: { id: 'tpl-person', autofill: true }
    },
    { id: 'tpl-person', name: 'Person profile' }
  )
  defineTag(data.db, 'employee', { extends: 'person', fields: [{ name: 'Team' }] })
  defineTag(data.db, 'person/vip', { extends: 'person' })
  defineTag(data.db, 'candidate', { fields: [{ name: 'Role' }] })

  insertNote(index.db, {
    id: 'ahmet',
    tags: [['person', true]],
    properties: [['Role', 'PM']]
  })
  insertNote(index.db, { id: 'elif', tags: [['Person', true]], properties: [['Phone', '555']] })
  insertNote(index.db, { id: 'bare', tags: [['person', true]] })
  insertNote(index.db, {
    id: 'eng',
    tags: [['employee', true]],
    properties: [['Role', 'CTO']]
  })
  insertNote(index.db, { id: 'vip', tags: [['person/vip', true]] })
  insertNote(index.db, { id: 'mention', tags: [['person', false]], properties: [['Role', 'x']] })
  insertNote(index.db, { id: 'diary', tags: [['person', true]], date: '2026-01-01' })
  insertNote(index.db, { id: 'scan', tags: [['person', true]], fileType: 'pdf' })
  insertNote(index.db, {
    id: 'applicant',
    tags: [['candidate', true]],
    properties: [['Role', 'Dev']]
  })
  insertNote(index.db, { id: 'draft-a', tags: [['project', true]] })
  insertNote(index.db, { id: 'draft-b', tags: [['Project', true]] })

  insertTask(data.db, 't-filled', ['person'], { Role: { v: 'Lead', t: 1 } })
  insertTask(data.db, 't-empty', ['person'], null)
  insertTask(data.db, 't-cleared', ['employee'], { Role: { v: null, t: 2 } })
  insertTask(data.db, 't-other', ['company'], { Role: { v: 'Buyer', t: 1 } })
})

afterEach(() => {
  data.close()
  index.close()
})

describe('previewing a schema change', () => {
  it('counts removing a field as filled and empty values across the tag, its children and tasks', async () => {
    const result = await impact({ kind: 'remove-field', tag: 'Person', name: 'Role' })

    // objects: ahmet, elif, bare, eng, vip + tasks t-filled, t-empty, t-cleared = 8.
    // filled: ahmet, eng + t-filled. A cleared task value and header-less mentions are empty.
    expect(result).toEqual({ kind: 'remove-field', filled: 3, empty: 5 })
  })

  it('counts a rename vault-wide: every note and task holding the field and every tag listing it', async () => {
    const result = await impact({ kind: 'rename-field', name: 'Role' })

    expect(result).toMatchObject({ kind: 'rename-field', notes: 4, tasks: 2 })
    expect(result.kind === 'rename-field' && [...result.tags].sort()).toEqual([
      'candidate',
      'person'
    ])
  })

  it('counts what deleting a tag takes with it, including its template name', async () => {
    const result = await impact({ kind: 'delete-tag', tag: 'person' })

    // Header carriers of exactly this tag: ahmet, elif, bare. Not the diary, the PDF, the
    // mention or the child tags. Values: ahmet's Role and elif's Phone.
    expect(result).toEqual({
      kind: 'delete-tag',
      notes: 3,
      tasks: 2,
      values: 2,
      fields: 2,
      templateName: 'Person profile'
    })
  })

  it('reports no template name when the template is inherited from a parent', async () => {
    const result = await impact({ kind: 'delete-tag', tag: 'employee' })

    expect(result).toEqual({
      kind: 'delete-tag',
      notes: 1,
      tasks: 1,
      // eng's Role is an inherited field: deleting the tag loses it as a value of the tag.
      values: 1,
      fields: 1,
      templateName: null
    })
  })

  it('reports zeros for a tag that has no definition', async () => {
    expect(await impact({ kind: 'delete-tag', tag: 'ghost' })).toEqual({
      kind: 'delete-tag',
      notes: 0,
      tasks: 0,
      values: 0,
      fields: 0,
      templateName: null
    })
  })

  it('lists the inherited fields lost when a tag stops extending its parent', async () => {
    const result = await impact({ kind: 'set-extends', tag: 'employee', parent: null })

    expect(result).toEqual({ kind: 'set-extends', notes: 1, gained: [], lost: ['Role', 'Phone'] })
  })

  it('lists the fields gained from a new parent and skips a name the tag already owns', async () => {
    const result = await impact({ kind: 'set-extends', tag: 'candidate', parent: 'person' })

    // candidate owns Role, so only Phone is new.
    expect(result).toEqual({ kind: 'set-extends', notes: 1, gained: ['Phone'], lost: [] })
  })

  it('counts the header notes that become objects, folding tag spelling', async () => {
    expect(await impact({ kind: 'become-objects', tag: 'project' })).toEqual({
      kind: 'become-objects',
      notes: 2
    })
  })

  it('counts child-tag notes when a parent tag becomes an object tag', async () => {
    expect(await impact({ kind: 'become-objects', tag: 'person' })).toEqual({
      kind: 'become-objects',
      // ahmet, elif, bare, eng (via employee) and vip (via person/vip).
      notes: 5
    })
  })
})
