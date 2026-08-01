/**
 * Folder view IPC handlers tests
 *
 * @module ipc/folder-view-handlers.test
 */

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { mockIpcMain, resetIpcMocks, invokeHandler } from '@tests/utils/mock-ipc'
import { FolderViewChannels } from '@memry/contracts/ipc-channels'
import { DEFAULT_VIEW } from '@memry/contracts/folder-view-api'
import { noteCache, noteTags, noteProperties } from '@memry/db-schema/schema/notes-cache'
import {
  createTestIndexDb,
  createTestDataDb,
  seedInboxItem,
  seedInboxItemTags,
  sql,
  type TestDatabaseResult,
  type TestDb
} from '@tests/utils/test-db'

const handleCalls: unknown[][] = []
const removeHandlerCalls: string[] = []

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: unknown) => {
      handleCalls.push([channel, handler])
      mockIpcMain.handle(channel, handler as Parameters<typeof mockIpcMain.handle>[1])
    }),
    removeHandler: vi.fn((channel: string) => {
      removeHandlerCalls.push(channel)
      mockIpcMain.removeHandler(channel)
    })
  }
}))

vi.mock('../database', () => ({
  getIndexDatabase: vi.fn(),
  getDatabase: vi.fn()
}))

vi.mock('../vault/folders', () => ({
  readFolderConfig: vi.fn(),
  writeFolderConfig: vi.fn()
}))

vi.mock('../inbox/suggestions', () => ({
  getNoteFolderSuggestions: vi.fn()
}))

import { registerFolderViewHandlers, unregisterFolderViewHandlers } from './folder-view-handlers'
import { getIndexDatabase, getDatabase } from '../database'
import * as folderFiles from '../vault/folders'
import * as suggestions from '../inbox/suggestions'

// ============================================================================
// Tag-scope fixture helpers
// (No seedNote/seedTask generic helpers exist in the codebase — notes live in
// index.db, tasks/inbox live in data.db, so seeding follows the raw-SQL
// per-source helper pattern already used in tag-items.test.ts.)
// ============================================================================

function insertTask(dataDb: TestDb, id: string, title: string): void {
  dataDb.run(sql`
    INSERT INTO projects (id, name, is_inbox, position)
    VALUES ('inbox', 'Inbox', 1, 0)
    ON CONFLICT DO NOTHING
  `)
  dataDb.run(sql`
    INSERT INTO statuses (id, project_id, name, color, position, is_default, is_done)
    VALUES ('status-default', 'inbox', 'To Do', '#6b7280', 0, 1, 0)
    ON CONFLICT DO NOTHING
  `)
  dataDb.run(sql`
    INSERT INTO tasks (id, project_id, status_id, title, position)
    VALUES (${id}, 'inbox', 'status-default', ${title}, 0)
  `)
}

function insertTaskTag(dataDb: TestDb, taskId: string, tag: string): void {
  dataDb.run(sql`INSERT OR IGNORE INTO task_tags (task_id, tag) VALUES (${taskId}, ${tag})`)
}

/**
 * Seed a tag_definitions row. writeTagViews only UPDATEs an existing row, so
 * saved-views tests need the row to already exist before they can round-trip.
 */
function insertTagDefinition(dataDb: TestDb, tag: string): void {
  dataDb.run(sql`INSERT INTO tag_definitions (name, color) VALUES (${tag}, 'red')`)
}

function insertTaggedNote(
  indexDbHandle: TestDb,
  opts: {
    id: string
    title: string
    path: string
    tag: string
    property?: { name: string; value: unknown }
  }
): void {
  const now = new Date().toISOString()
  indexDbHandle
    .insert(noteCache)
    .values({
      id: opts.id,
      path: opts.path,
      title: opts.title,
      contentHash: `hash-${opts.id}`,
      wordCount: 5,
      characterCount: 20,
      createdAt: now,
      modifiedAt: now
    })
    .run()
  indexDbHandle.insert(noteTags).values({ noteId: opts.id, tag: opts.tag, pinnedAt: null }).run()
  if (opts.property) {
    indexDbHandle
      .insert(noteProperties)
      .values({
        noteId: opts.id,
        name: opts.property.name,
        value: JSON.stringify(opts.property.value),
        type: 'text'
      })
      .run()
  }
}

describe('folder-view-handlers', () => {
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    resetIpcMocks()
    vi.clearAllMocks()
    handleCalls.length = 0
    removeHandlerCalls.length = 0

    indexDb = createTestIndexDb()
    ;(getIndexDatabase as Mock).mockReturnValue(indexDb.db)
  })

  afterEach(() => {
    unregisterFolderViewHandlers()
    indexDb.close()
  })

  it('returns default config and views when none exist', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue(null)

    const config = await invokeHandler(FolderViewChannels.invoke.GET_CONFIG, {
      folderPath: 'projects'
    })
    expect(config.isDefault).toBe(true)
    expect(config.config.views).toHaveLength(1)

    const views = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
      scope: { kind: 'folder', path: 'projects' }
    })
    expect(views.views).toHaveLength(1)
    expect(views.defaultIndex).toBe(0)
  })

  it('sets config and returns success', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({ views: [] })

    const result = await invokeHandler(FolderViewChannels.invoke.SET_CONFIG, {
      folderPath: 'projects',
      config: { views: [] }
    })
    expect(result).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalled()
  })

  it('adds or updates a view and enforces default selection', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [{ name: 'Default', type: 'table', default: true }]
    })

    const result = await invokeHandler(FolderViewChannels.invoke.SET_VIEW, {
      scope: { kind: 'folder', path: 'projects' },
      view: { name: 'Gallery', type: 'grid', default: true }
    })

    expect(result).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({
        views: [
          expect.objectContaining({ name: 'Default', default: false }),
          expect.objectContaining({ name: 'Gallery', default: true })
        ]
      })
    )
  })

  it('deletes views and restores defaults as needed', async () => {
    registerFolderViewHandlers()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [{ name: 'Only', type: 'table', default: true }]
    })
    const deleteAll = await invokeHandler(FolderViewChannels.invoke.DELETE_VIEW, {
      scope: { kind: 'folder', path: 'projects' },
      viewName: 'Only'
    })
    expect(deleteAll).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({ views: undefined })
    )
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({
      views: [
        { name: 'Default', type: 'table', default: true },
        { name: 'Alt', type: 'list', default: false }
      ]
    })
    const deleteDefault = await invokeHandler(FolderViewChannels.invoke.DELETE_VIEW, {
      scope: { kind: 'folder', path: 'projects' },
      viewName: 'Default'
    })
    expect(deleteDefault).toEqual({ success: true })
    expect(folderFiles.writeFolderConfig).toHaveBeenCalledWith(
      'projects',
      expect.objectContaining({
        views: [expect.objectContaining({ name: 'Alt', default: true })]
      })
    )
  })

  it('lists notes with tags and properties', async () => {
    registerFolderViewHandlers()

    const now = new Date().toISOString()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-1',
        path: 'projects/2024/note.md',
        title: 'Note',
        contentHash: 'hash',
        wordCount: 5,
        characterCount: 20,
        createdAt: now,
        modifiedAt: now
      })
      .run()

    indexDb.db
      .insert(noteTags)
      .values({
        noteId: 'note-1',
        tag: 'alpha',
        pinnedAt: null
      })
      .run()

    indexDb.db
      .insert(noteProperties)
      .values({
        noteId: 'note-1',
        name: 'status',
        value: JSON.stringify('open'),
        type: 'text'
      })
      .run()

    const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
      scope: { kind: 'folder', path: 'projects' },
      properties: ['status'],
      limit: 10,
      offset: 0
    })

    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]?.folder).toBe('/2024')
    expect(result.notes[0]?.tags).toEqual(['alpha'])
    expect(result.notes[0]?.properties).toEqual({ status: 'open' })
  })

  it('returns available properties and folder suggestions', async () => {
    registerFolderViewHandlers()

    const now = new Date().toISOString()
    indexDb.db
      .insert(noteCache)
      .values({
        id: 'note-2',
        path: 'projects/note.md',
        title: 'Note',
        contentHash: 'hash',
        wordCount: 2,
        characterCount: 10,
        createdAt: now,
        modifiedAt: now
      })
      .run()
    indexDb.db
      .insert(noteProperties)
      .values({
        noteId: 'note-2',
        name: 'priority',
        value: JSON.stringify(1),
        type: 'number'
      })
      .run()
    ;(folderFiles.readFolderConfig as Mock).mockResolvedValue({ formulas: { score: '1+1' } })
    const props = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
      scope: { kind: 'folder', path: 'projects' }
    })
    expect(props.properties).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'priority', type: 'number' })])
    )
    ;(suggestions.getNoteFolderSuggestions as Mock).mockResolvedValue([
      { path: 'projects', confidence: 0.5, reason: 'History' }
    ])
    const suggestionResult = await invokeHandler(FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS, {
      noteId: 'note-2'
    })
    expect(suggestionResult.suggestions).toHaveLength(1)
  })

  describe('list-with-properties under tag scope', () => {
    let dataDb: TestDatabaseResult

    beforeEach(() => {
      registerFolderViewHandlers()

      dataDb = createTestDataDb()
      ;(getDatabase as Mock).mockReturnValue(dataDb.db)
    })

    afterEach(() => {
      dataDb.close()
    })

    it('returns notes, tasks and inbox items carrying the tag', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-araba',
        title: 'Araba notu',
        path: 'projects/araba.md',
        tag: 'araba'
      })
      insertTask(dataDb.db, 'task-araba', 'Araba task')
      insertTaskTag(dataDb.db, 'task-araba', 'araba')
      const inboxId = seedInboxItem(dataDb.db, { id: 'inbox-araba', title: 'Araba inbox' })
      seedInboxItemTags(dataDb.db, inboxId, ['araba'])

      const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' },
        limit: 500,
        offset: 0
      })

      expect(result.notes.map((r) => r.kind).sort()).toEqual(['inbox', 'note', 'task'])
    })

    it('fills real properties on note rows', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-araba',
        title: 'Araba notu',
        path: 'projects/araba.md',
        tag: 'araba',
        property: { name: 'status', value: 'active' }
      })

      const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' },
        limit: 500,
        offset: 0
      })

      const noteRow = result.notes.find((r) => r.kind === 'note')!
      expect(noteRow.properties).toEqual({ status: 'active' })
    })

    it('leaves properties empty on task and inbox rows', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-araba',
        title: 'Araba notu',
        path: 'projects/araba.md',
        tag: 'araba',
        property: { name: 'status', value: 'active' }
      })
      insertTask(dataDb.db, 'task-araba', 'Araba task')
      insertTaskTag(dataDb.db, 'task-araba', 'araba')
      const inboxId = seedInboxItem(dataDb.db, { id: 'inbox-araba', title: 'Araba inbox' })
      seedInboxItemTags(dataDb.db, inboxId, ['araba'])

      const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' },
        limit: 500,
        offset: 0
      })

      for (const row of result.notes.filter((r) => r.kind !== 'note')) {
        expect(row.properties).toEqual({})
      }
    })

    it('includes descendant tags but not same-prefix siblings', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-lastik',
        title: 'Lastik notu',
        path: 'projects/lastik.md',
        tag: 'araba/lastik'
      })
      insertTaggedNote(indexDb.db, {
        id: 'note-arabalar',
        title: 'Arabalar notu',
        path: 'projects/arabalar.md',
        tag: 'arabalar'
      })

      const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' },
        limit: 500,
        offset: 0
      })

      const titles = result.notes.map((r) => r.title)
      expect(titles).toContain('Lastik notu')
      expect(titles).not.toContain('Arabalar notu')
    })

    it('still lists a folder by path', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-plain',
        title: 'Plain note',
        path: 'projects/plain.md',
        tag: 'unrelated'
      })

      const result = await invokeHandler(FolderViewChannels.invoke.LIST_WITH_PROPERTIES, {
        scope: { kind: 'folder', path: 'projects' },
        limit: 500,
        offset: 0
      })

      expect(result.notes.length).toBeGreaterThan(0)
      expect(result.notes.every((r) => r.kind === undefined || r.kind === 'note')).toBe(true)
    })
  })

  describe('get-available-properties under tag scope', () => {
    let dataDb: TestDatabaseResult

    beforeEach(() => {
      registerFolderViewHandlers()

      dataDb = createTestDataDb()
      ;(getDatabase as Mock).mockReturnValue(dataDb.db)
    })

    afterEach(() => {
      dataDb.close()
    })

    it('offers kind as a filterable built-in', async () => {
      const result = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.builtIn.map((c) => c.id)).toContain('kind')
    })

    it('does not offer kind for a folder, where every row is a note', async () => {
      const result = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
        scope: { kind: 'folder', path: 'projects' }
      })

      expect(result.builtIn.map((c) => c.id)).not.toContain('kind')
    })

    it("counts properties across the tag's notes, not a folder", async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-araba',
        title: 'Araba notu',
        path: 'projects/araba.md',
        tag: 'araba',
        property: { name: 'status', value: 'active' }
      })

      // Add an untagged note with the same property name to prove the handler
      // correctly scopes the count to only the tag's notes, not all notes in the database.
      insertTaggedNote(indexDb.db, {
        id: 'note-untagged',
        title: 'Untagged note',
        path: 'notes/untagged.md',
        tag: 'other-tag',
        property: { name: 'status', value: 'done' }
      })

      const result = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.properties).toContainEqual({ name: 'status', type: 'text', usageCount: 1 })
    })

    it('returns no formulas for a tag, which has no .folder.md', async () => {
      insertTaggedNote(indexDb.db, {
        id: 'note-araba',
        title: 'Araba notu',
        path: 'projects/araba.md',
        tag: 'araba'
      })

      const result = await invokeHandler(FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.formulas).toEqual([])
    })
  })

  describe('saved views under tag scope', () => {
    let dataDb: TestDatabaseResult

    beforeEach(() => {
      registerFolderViewHandlers()

      dataDb = createTestDataDb()
      ;(getDatabase as Mock).mockReturnValue(dataDb.db)
      insertTagDefinition(dataDb.db, 'araba')
      // Folder-scope reads must not accidentally pick up another test's
      // leftover mock value — pin this block's folder store to "no config".
      ;(folderFiles.readFolderConfig as Mock).mockResolvedValue(null)
    })

    afterEach(() => {
      dataDb.close()
    })

    it('falls back to the default view when the tag has none', async () => {
      const result = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.views).toEqual([DEFAULT_VIEW])
      expect(result.defaultIndex).toBe(0)
    })

    it('round-trips a saved view through the tag definition', async () => {
      await invokeHandler(FolderViewChannels.invoke.SET_VIEW, {
        scope: { kind: 'tag', tag: 'araba' },
        view: { name: 'Open tasks', type: 'table', default: true }
      })

      const result = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.views.map((v) => v.name)).toEqual(['Open tasks'])
    })

    it('deleting the last view falls back to the default again', async () => {
      await invokeHandler(FolderViewChannels.invoke.SET_VIEW, {
        scope: { kind: 'tag', tag: 'araba' },
        view: { name: 'Open tasks', type: 'table', default: true }
      })
      await invokeHandler(FolderViewChannels.invoke.DELETE_VIEW, {
        scope: { kind: 'tag', tag: 'araba' },
        viewName: 'Open tasks'
      })

      const result = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
        scope: { kind: 'tag', tag: 'araba' }
      })

      expect(result.views).toEqual([DEFAULT_VIEW])
    })

    it('keeps folder and tag views in separate stores', async () => {
      await invokeHandler(FolderViewChannels.invoke.SET_VIEW, {
        scope: { kind: 'tag', tag: 'araba' },
        view: { name: 'Tag view', type: 'table', default: true }
      })

      const folderResult = await invokeHandler(FolderViewChannels.invoke.GET_VIEWS, {
        scope: { kind: 'folder', path: 'araba' }
      })

      expect(folderResult.views.map((v) => v.name)).not.toContain('Tag view')
    })
  })
})
