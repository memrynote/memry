import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { tasks } from '@memry/db-schema/schema/tasks'
import { settings } from '@memry/db-schema/schema/settings'
import { formatDateKey } from '@memry/domain-tasks/parsing'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type * as LocalMutationsModule from '../sync/local-mutations'

const state = vi.hoisted(() => ({ db: null as unknown }))
const sync = vi.hoisted(() => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
const notes = vi.hoisted(() => ({
  createNoteCommand: vi.fn(),
  deleteNoteCommand: vi.fn(),
  getFolders: vi.fn(),
  createFolder: vi.fn(),
  syncFolderConfigCreate: vi.fn(),
  appendToJournalEntry: vi.fn()
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('../database', () => ({ getDatabase: () => state.db, requireDatabase: () => state.db }))
vi.mock('../sync/local-mutations', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalMutationsModule>()),
  ...sync
}))
vi.mock('../notes/domain', () => ({
  createNoteCommand: notes.createNoteCommand,
  deleteNoteCommand: notes.deleteNoteCommand
}))
vi.mock('../vault/notes', () => ({
  getFolders: notes.getFolders,
  createFolder: notes.createFolder
}))
vi.mock('../notes/folder-config-effects', () => ({
  syncFolderConfigCreate: notes.syncFolderConfigCreate
}))
vi.mock('../journal/update-entry', () => ({ appendToJournalEntry: notes.appendToJournalEntry }))

import { listStickyDrafts, saveStickyDraft } from './drafts'
import { sendSticky, undoStickySend, STICKY_FOLDER } from './send'
import { getStickySettings } from '../settings/sticky-settings'
import { ensureDefaultTaskProject } from '../database/defaults'
import type { DataDb } from '../database/types'

describe('sticky send', () => {
  let data: TestDatabaseResult

  beforeEach(() => {
    vi.clearAllMocks()
    data = createTestDataDb()
    state.db = data.db
    // The vault opening seeds it in the app.
    ensureDefaultTaskProject(data.db as unknown as DataDb)
    notes.getFolders.mockResolvedValue([])
    notes.createNoteCommand.mockImplementation(async (input: { title: string }) => ({
      id: 'note-1',
      title: input.title
    }))
  })

  afterEach(() => data.close())

  it('creates the note in the Sticky folder, then drops the draft and remembers the kind', async () => {
    const draft = saveStickyDraft({ content: 'Groceries\n- oat milk\n- bread', kind: 'note' })

    const result = await sendSticky({ draftId: draft.id, content: draft.content, kind: 'note' })

    expect(result).toMatchObject({ success: true, kind: 'note', targetId: 'note-1' })
    expect(notes.createFolder).toHaveBeenCalledWith(STICKY_FOLDER)
    expect(notes.syncFolderConfigCreate).toHaveBeenCalledWith(STICKY_FOLDER)
    expect(notes.createNoteCommand).toHaveBeenCalledWith({
      title: 'Groceries',
      content: '- oat milk\n- bread',
      folder: STICKY_FOLDER
    })
    expect(listStickyDrafts()).toEqual([])
    expect(sync.enqueueLocalSyncDelete).toHaveBeenCalledWith(
      'sticky_draft',
      draft.id,
      expect.any(String)
    )
  })

  it('reuses an existing Sticky folder', async () => {
    notes.getFolders.mockResolvedValue([{ path: STICKY_FOLDER }])
    await sendSticky({ draftId: null, content: 'Idea', kind: 'note' })
    expect(notes.createFolder).not.toHaveBeenCalled()
  })

  it('keeps the draft when the target refuses the text', async () => {
    notes.createNoteCommand.mockRejectedValue(new Error('Vault is locked'))
    const draft = saveStickyDraft({ content: 'Keep me', kind: 'note' })

    const result = await sendSticky({ draftId: draft.id, content: draft.content, kind: 'note' })

    expect(result).toEqual({ success: false, error: 'Vault is locked' })
    expect(listStickyDrafts().map((d) => d.content)).toEqual(['Keep me'])
  })

  it('creates a task from quick-add grammar, and Undo deletes it and restores the draft', async () => {
    const draft = saveStickyDraft({
      content: 'Call Ana @tomorrow !high\nabout the lease',
      kind: 'task'
    })

    const result = await sendSticky({ draftId: draft.id, content: draft.content, kind: 'task' })
    if (!result.success) throw new Error(result.error)

    const row = data.db.select().from(tasks).where(eq(tasks.id, result.targetId)).get()
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    expect(row).toMatchObject({
      title: 'Call Ana',
      description: 'about the lease',
      priority: 3,
      dueDate: formatDateKey(tomorrow)
    })
    expect(getStickySettings().lastKind).toBe('task')
    expect(listStickyDrafts()).toEqual([])

    const undo = await undoStickySend(result.undoToken!)

    expect(undo).toMatchObject({ success: true, draft: { content: draft.content, kind: 'task' } })
    expect(data.db.select().from(tasks).where(eq(tasks.id, result.targetId)).get()).toBeUndefined()
    expect(listStickyDrafts().map((d) => d.content)).toEqual([draft.content])
    expect(await undoStickySend(result.undoToken!)).toMatchObject({ success: false })
  })

  it('appends to today’s journal without an undo token', async () => {
    const result = await sendSticky({ draftId: null, content: 'Good walk today', kind: 'journal' })

    expect(notes.appendToJournalEntry).toHaveBeenCalledWith(
      formatDateKey(new Date()),
      'Good walk today'
    )
    expect(result).toMatchObject({ success: true, kind: 'journal', undoToken: null })
  })

  it('refuses kinds whose module is turned off and keeps the draft', async () => {
    data.db
      .insert(settings)
      .values({ key: 'features', value: JSON.stringify({ tasks: false, journal: false }) })
      .run()
    const draft = saveStickyDraft({ content: 'Pay rent', kind: 'task' })

    const task = await sendSticky({ draftId: draft.id, content: draft.content, kind: 'task' })
    const journal = await sendSticky({ draftId: draft.id, content: draft.content, kind: 'journal' })

    expect(task).toMatchObject({ success: false })
    expect(journal).toMatchObject({ success: false })
    expect(notes.appendToJournalEntry).not.toHaveBeenCalled()
    expect(listStickyDrafts()).toHaveLength(1)
  })
})
