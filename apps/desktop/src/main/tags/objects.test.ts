/**
 * Object reads for tags with fields, through the real IPC handlers on real
 * index.db and data.db schemas.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { invokeHandler, mockIpcMain, resetIpcMocks } from '@tests/utils/mock-ipc'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  sql,
  type TestDb
} from '@tests/utils/test-db'
import { FolderViewChannels, TagsChannels } from '@memry/contracts/ipc-channels'
import type {
  GetViewsResponse,
  GetAvailablePropertiesResponse,
  ListWithPropertiesResponse
} from '@memry/contracts/folder-view-api'
import type { GetLinkedHereResponse, SearchObjectsResponse } from '@memry/contracts/tag-objects-api'

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Parameters<typeof mockIpcMain.handle>[1]) =>
      mockIpcMain.handle(channel, handler),
    removeHandler: (channel: string) => mockIpcMain.removeHandler(channel)
  }
}))
vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn(),
  requireDatabase: vi.fn()
}))
vi.mock('../vault/folders', () => ({ readFolderConfig: vi.fn(), writeFolderConfig: vi.fn() }))
vi.mock('../inbox/suggestions', () => ({ getNoteFolderSuggestions: vi.fn() }))

import { getDatabase, getIndexDatabase, requireDatabase } from '../database'
import {
  registerFolderViewHandlers,
  unregisterFolderViewHandlers
} from '../ipc/folder-view-handlers'
import { registerTagObjectHandlers, unregisterTagObjectHandlers } from '../ipc/tag-object-handlers'
import { buildObjectIndex, loadResolvedTags } from './objects'

interface NoteFixture {
  id: string
  title?: string
  tags?: Array<[tag: string, inHeader: boolean | null]>
  date?: string
  fileType?: 'markdown' | 'pdf'
  modified?: string
  properties?: Array<[name: string, value: string, type: string]>
}

function insertNote(db: TestDb, note: NoteFixture): void {
  const modified = note.modified ?? '2026-01-01T00:00:00.000Z'
  db.run(sql`
    INSERT INTO note_cache (id, path, title, file_type, date, content_hash, created_at, modified_at)
    VALUES (${note.id}, ${`notes/${note.id}.md`}, ${note.title ?? note.id},
            ${note.fileType ?? 'markdown'}, ${note.date ?? null}, ${'h-' + note.id},
            ${modified}, ${modified})
  `)
  ;(note.tags ?? []).forEach(([tag, inHeader], position) => {
    db.run(sql`
      INSERT INTO note_tags (note_id, tag, position, in_header)
      VALUES (${note.id}, ${tag}, ${position}, ${inHeader === null ? null : Number(inHeader)})
    `)
  })
  for (const [name, value, type] of note.properties ?? []) {
    db.run(sql`
      INSERT INTO note_properties (note_id, name, value, type)
      VALUES (${note.id}, ${name}, ${value}, ${type})
    `)
  }
}

function defineTag(db: TestDb, name: string, schema: object | null): void {
  db.run(sql`
    INSERT INTO tag_definitions (name, color, schema)
    VALUES (${name}, 'blue', ${schema === null ? null : JSON.stringify({ t: 1, ...schema })})
  `)
}

function insertTask(db: TestDb, id: string, tags: string[], fields: object | null = null): void {
  db.run(sql`INSERT INTO projects (id, name, is_inbox, position) VALUES ('inbox', 'Inbox', 1, 0)
             ON CONFLICT DO NOTHING`)
  db.run(sql`
    INSERT INTO tasks (id, project_id, title, position, fields)
    VALUES (${id}, 'inbox', ${'Task ' + id}, 0, ${fields === null ? null : JSON.stringify(fields)})
  `)
  for (const tag of tags) db.run(sql`INSERT INTO task_tags (task_id, tag) VALUES (${id}, ${tag})`)
}

const noteUri = (id: string): string => `memry://note/${id}`

describe('object reads for tags with fields', () => {
  let index: ReturnType<typeof createTestIndexDb>
  let data: ReturnType<typeof createTestDataDb>

  beforeEach(() => {
    resetIpcMocks()
    index = createTestIndexDb()
    data = createTestDataDb()
    ;(getIndexDatabase as Mock).mockReturnValue(index.db)
    ;(getDatabase as Mock).mockReturnValue(data.db)
    ;(requireDatabase as Mock).mockReturnValue(data.db)
    registerFolderViewHandlers()
    registerTagObjectHandlers()

    defineTag(data.db, 'person', {
      fields: [{ name: 'Role' }, { name: 'Company', relation: { target: 'company' } }]
    })
    defineTag(data.db, 'employee', { extends: 'person', fields: [{ name: 'Team' }] })
    defineTag(data.db, 'company', { fields: [{ name: 'Website' }] })
    defineTag(data.db, 'person/vip', null)
  })

  afterEach(() => {
    unregisterFolderViewHandlers()
    unregisterTagObjectHandlers()
    index.close()
    data.close()
  })

  const listRows = (
    tag: string,
    rows?: 'objects' | 'mentions'
  ): Promise<ListWithPropertiesResponse> =>
    invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'tag', tag },
      limit: 500,
      offset: 0,
      ...(rows ? { rows } : {})
    })

  it('splits a tag with fields into header objects and mentions', async () => {
    insertNote(index.db, {
      id: 'ahmet',
      tags: [['person', true]],
      properties: [['Role', '123', 'text']]
    })
    insertNote(index.db, { id: 'eng', tags: [['employee', true]] })
    insertNote(index.db, { id: 'inline', tags: [['person', false]] })
    insertNote(index.db, { id: 'journal', tags: [['person', true]], date: '2026-01-02' })
    insertNote(index.db, { id: 'scan', tags: [['person', true]], fileType: 'pdf' })
    insertNote(index.db, { id: 'vip', tags: [['person/vip', true]] })
    insertTask(data.db, 'call', ['person'], { Role: { v: 'Lead', t: 1 } })

    const objects = await listRows('person')
    const mentions = await listRows('person', 'mentions')

    expect(objects.complete).toBe(true)
    expect(objects.notes.map((row) => [row.id, row.viaTag ?? null, row.properties]).sort()).toEqual(
      [
        ['ahmet', null, { Role: '123' }],
        ['call', null, { Role: 'Lead' }],
        ['eng', 'employee', {}]
      ]
    )
    expect(mentions.notes.map((row) => row.id).sort()).toEqual(['inline', 'journal', 'scan', 'vip'])
  })

  it('never counts a row without a header flag and reports the read incomplete', async () => {
    insertNote(index.db, { id: 'old', tags: [['person', null]] })
    insertNote(index.db, { id: 'new', tags: [['person', true]] })

    const objects = await listRows('person')
    const mentions = await listRows('person', 'mentions')
    const snapshot = buildObjectIndex(index.db, loadResolvedTags(asClientDb(data.db)))

    expect(objects.notes.map((row) => row.id)).toEqual(['new'])
    expect(objects.complete).toBe(false)
    expect(mentions.notes.map((row) => row.id)).toEqual(['old'])
    expect(snapshot).toEqual({ objects: { new: 'person' }, complete: false })
  })

  it('keeps a plain tag page as the full union with today values', async () => {
    insertNote(index.db, { id: 'a', tags: [['plain', true]], properties: [['n', '123', 'text']] })
    insertNote(index.db, { id: 'b', tags: [['plain', false]] })
    insertNote(index.db, { id: 'j', tags: [['plain', true]], date: '2026-01-02' })
    insertNote(index.db, { id: 'c', tags: [['plain/child', null]] })

    const result = await listRows('plain', 'mentions')

    expect(result.complete).toBeUndefined()
    expect(result.notes.map((row) => row.id).sort()).toEqual(['a', 'b', 'c', 'j'])
    expect(result.notes.every((row) => row.viaTag === undefined)).toBe(true)
    // Plain tags keep the legacy JSON.parse of stored values (unchanged output).
    expect(result.notes.find((row) => row.id === 'a')?.properties).toEqual({ n: 123 })
  })

  it('derives the default view and empty field columns from the schema', async () => {
    const views = await invokeHandler<GetViewsResponse>(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'tag', tag: 'employee' }
    })
    const available = await invokeHandler<GetAvailablePropertiesResponse>(
      FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES,
      { scope: { kind: 'tag', tag: 'employee' } }
    )

    expect(views.views[0]?.columns?.map((column) => column.id)).toEqual([
      'title',
      'Role',
      'Company',
      'Team',
      'modified'
    ])
    expect(available.properties.map((p) => [p.name, p.type, p.usageCount])).toEqual([
      ['Role', 'text', 0],
      ['Company', 'relation', 0],
      ['Team', 'text', 0]
    ])
  })

  it('searches objects with locale folding, grouped under the root tag', async () => {
    insertNote(index.db, { id: 'acme', title: 'Acme', tags: [['company', true]] })
    insertNote(index.db, {
      id: 'ilker',
      title: 'İlker Şahin',
      tags: [['employee', true]],
      properties: [
        ['Role', 'Engineer', 'text'],
        ['Company', JSON.stringify([noteUri('acme')]), 'relation']
      ]
    })
    insertNote(index.db, { id: 'isik', title: 'Işık', tags: [['person', true]] })
    insertNote(index.db, { id: 'mention', title: 'Ilker notes', tags: [['person', false]] })

    const byName = await invokeHandler<SearchObjectsResponse>(TagsChannels.invoke.SEARCH_OBJECTS, {
      query: 'ilker sa'
    })
    const dotless = await invokeHandler<SearchObjectsResponse>(TagsChannels.invoke.SEARCH_OBJECTS, {
      query: 'ISIK',
      tag: 'person'
    })

    expect(byName.matches).toEqual([
      {
        noteId: 'ilker',
        title: 'İlker Şahin',
        tag: 'employee',
        groupTag: 'person',
        viaTag: 'employee',
        subtitle: ['Engineer', 'Acme'],
        modified: '2026-01-01T00:00:00.000Z'
      }
    ])
    expect(dotless.matches.map((match) => match.noteId)).toEqual(['isik'])
  })

  it('lists what points at a note: relation fields, task fields and wiki links', async () => {
    insertNote(index.db, { id: 'acme', tags: [['company', true]] })
    insertNote(index.db, { id: 'ahmet', tags: [['person', true]] })
    insertNote(index.db, { id: 'daily', date: '2026-01-02' })
    index.db
      .run(sql`INSERT INTO property_refs (source_note_id, property_name, target_type, target_id)
                     VALUES ('ahmet', 'Company', 'note', 'acme')`)
    index.db.run(sql`INSERT INTO note_links (source_id, target_id, target_title)
                     VALUES ('daily', 'acme', 'Acme')`)
    data.db.run(sql`
      INSERT INTO tag_definitions (name, color, schema)
      VALUES ('followup', 'red', ${JSON.stringify({ t: 1, fields: [{ name: 'Waiting on', relation: { target: 'company' } }] })})
    `)
    insertTask(data.db, 'ping', ['followup'], { 'Waiting on': { v: [noteUri('acme')], t: 2 } })
    insertTask(data.db, 'stale', ['followup'], {
      'Waiting on': { v: null, t: 3, was: noteUri('acme') }
    })

    const { groups } = await invokeHandler<GetLinkedHereResponse>(
      TagsChannels.invoke.GET_LINKED_HERE,
      { noteId: 'acme' }
    )

    expect(groups).toEqual([
      {
        kind: 'relation',
        sourceTag: 'person',
        field: 'Company',
        label: 'person',
        total: 1,
        items: [{ noteId: 'ahmet', title: 'ahmet', date: null, snippet: null }],
        filter: `Company contains "${noteUri('acme')}"`
      },
      {
        kind: 'task-field',
        tag: 'followup',
        field: 'Waiting on',
        total: 1,
        items: [{ taskId: 'ping', title: 'Task ping', dueDate: null, completed: false }],
        filter: `Waiting on contains "${noteUri('acme')}"`
      },
      {
        kind: 'mentions',
        total: 1,
        items: [{ noteId: 'daily', title: 'daily', date: '2026-01-02', snippet: null }]
      }
    ])
  })
})
