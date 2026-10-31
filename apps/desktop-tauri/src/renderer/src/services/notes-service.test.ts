import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'

const commands = vi.hoisted(() => ({
  notesGet: vi.fn(),
  notesGetByPath: vi.fn(),
  notesGetFile: vi.fn(),
  notesList: vi.fn(),
  notesExists: vi.fn(),
  notesOpenExternal: vi.fn(),
  notesRevealInFinder: vi.fn(),
  notesGetLinks: vi.fn(),
  notesResolveByTitle: vi.fn(),
  notesResolveTitles: vi.fn(),
  notesResolveWikiTarget: vi.fn()
}))

vi.mock('../../../generated/bindings', () => ({ commands }))

import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteRenamed,
  onNoteMoved,
  onNoteExternalChange,
  onTagsChanged,
  onFolderConfigUpdated
} from './notes-service'

const CREATED = Date.UTC(2026, 0, 2)
const MODIFIED = Date.UTC(2026, 0, 3)

describe('notes-service', () => {
  let api: any

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
    for (const command of Object.values(commands)) command.mockReset()
  })

  it('reads notes through the notes commands, with dates as Electron sends them', async () => {
    commands.notesList.mockResolvedValue({
      notes: [
        {
          id: 'note-1',
          path: 'work/Plan.md',
          title: 'Plan',
          created: CREATED,
          modified: MODIFIED,
          tags: ['alpha'],
          wordCount: null,
          emoji: null,
          localOnly: false,
          fileType: 'markdown'
        }
      ],
      total: 1,
      hasMore: false
    })
    commands.notesGet.mockResolvedValue(null)
    commands.notesGetFile.mockResolvedValue({
      id: 'file-1',
      path: 'scan.pdf',
      absolutePath: '/vault/scan.pdf',
      title: 'scan',
      fileType: 'pdf',
      mimeType: 'application/pdf',
      fileSize: 3,
      created: CREATED,
      modified: MODIFIED
    })

    const page = await notesService.list({ folder: 'work', fields: 'tree' })
    expect(commands.notesList).toHaveBeenCalledWith({ folder: 'work', fields: 'tree' })
    expect(page.notes[0].created).toEqual(new Date(CREATED))
    expect(page.notes[0].modified).toEqual(new Date(MODIFIED))
    expect(await notesService.get('gone')).toBeNull()
    expect((await notesService.getFile('file-1'))?.modified).toEqual(new Date(MODIFIED))
    expect(api.notes.list).not.toHaveBeenCalled()
  })

  it('reads by path, answers exists, and opens or reveals through the commands', async () => {
    commands.notesGetByPath.mockResolvedValue({
      id: 'note-1',
      path: 'work/Plan.md',
      title: 'Plan',
      content: 'body',
      frontmatter: {},
      created: CREATED,
      modified: MODIFIED,
      tags: [],
      aliases: [],
      wordCount: 1,
      properties: {}
    })
    commands.notesExists.mockResolvedValue(true)
    commands.notesOpenExternal.mockRejectedValue({ code: 'notes.not_found' })
    commands.notesRevealInFinder.mockResolvedValue(null)

    const note = await notesService.getByPath('work/Plan.md')
    expect(commands.notesGetByPath).toHaveBeenCalledWith('work/Plan.md')
    expect(note?.modified).toEqual(new Date(MODIFIED))
    expect(await notesService.exists('Plan')).toBe(true)
    expect(commands.notesExists).toHaveBeenCalledWith('Plan')
    await expect(notesService.openExternal('gone')).rejects.toEqual({ code: 'notes.not_found' })
    await notesService.revealInFinder('note-1')
    expect(commands.notesRevealInFinder).toHaveBeenCalledWith('note-1')
    expect(api.notes.getByPath).not.toHaveBeenCalled()
    expect(api.notes.exists).not.toHaveBeenCalled()
  })

  it('reads links and resolves wiki targets through the link commands', async () => {
    const links = {
      outgoing: [{ sourceId: 'note-1', targetId: null, targetTitle: 'Nowhere' }],
      incoming: [
        {
          sourceId: 'note-2',
          sourcePath: 'Dense.md',
          sourceTitle: 'Dense',
          contexts: [{ snippet: '[[Plan]]', linkStart: 0, linkEnd: 8 }],
          mentionCount: 60,
          truncated: true
        }
      ]
    }
    const plan = { id: 'note-1', path: 'work/Plan.md', title: 'Plan', fileType: 'markdown' }
    commands.notesGetLinks.mockResolvedValue(links)
    commands.notesResolveByTitle.mockResolvedValue(plan)
    commands.notesResolveTitles.mockResolvedValue({
      plan: { id: 'note-1', path: 'work/Plan.md' },
      gone: null
    })
    commands.notesResolveWikiTarget.mockResolvedValue({ ...plan, heading: 'Goals' })

    expect(await notesService.getLinks('note-1')).toEqual(links)
    expect(commands.notesGetLinks).toHaveBeenCalledWith('note-1')
    expect(await notesService.resolveByTitle('plan')).toEqual(plan)
    expect(commands.notesResolveByTitle).toHaveBeenCalledWith('plan')
    expect(await notesService.resolveTitles(['plan', 'gone'])).toEqual({
      plan: { id: 'note-1', path: 'work/Plan.md' },
      gone: null
    })
    expect(commands.notesResolveTitles).toHaveBeenCalledWith(['plan', 'gone'])
    expect((await notesService.resolveWikiTarget('Plan#Goals'))?.heading).toBe('Goals')
    expect(commands.notesResolveWikiTarget).toHaveBeenCalledWith('Plan#Goals')
    expect(api.notes.getLinks).not.toHaveBeenCalled()
    expect(api.notes.resolveTitles).not.toHaveBeenCalled()
  })

  it('forwards the methods later steps port to window.api.notes', async () => {
    const createResponse = { success: true, note: { id: 'note-1' } }
    api.notes.create = vi.fn().mockResolvedValue(createResponse)
    api.notes.update = vi.fn().mockResolvedValue({ success: true })
    api.notes.rename = vi.fn().mockResolvedValue({ success: true })

    const createInput = { title: 'New note', content: 'Hello' }
    expect(await notesService.create(createInput)).toEqual(createResponse)
    expect(api.notes.create).toHaveBeenCalledWith(createInput)

    const updateInput = { id: 'note-1', title: 'Updated' }
    await notesService.update(updateInput)
    expect(api.notes.update).toHaveBeenCalledWith(updateInput)

    await notesService.rename('note-1', 'Renamed')
    expect(api.notes.rename).toHaveBeenCalledWith('note-1', 'Renamed')
  })

  it('forwards attachments, export, and version helpers', async () => {
    api.notes.uploadAttachment = vi.fn().mockResolvedValue({ success: true })
    api.notes.exportPdf = vi.fn().mockResolvedValue({ success: true })
    api.notes.getFolderConfig = vi.fn().mockResolvedValue({ template: 'default' })
    api.notes.setFolderConfig = vi.fn().mockResolvedValue({ success: true })
    api.notes.getFolderTemplate = vi.fn().mockResolvedValue('default')
    api.notes.getVersions = vi.fn().mockResolvedValue([])
    api.notes.restoreVersion = vi.fn().mockResolvedValue({ success: true })

    const file = new File(['data'], 'note.txt', { type: 'text/plain' })
    await notesService.uploadAttachment('note-1', file)
    expect(api.notes.uploadAttachment).toHaveBeenCalledWith('note-1', file)

    await notesService.exportPdf({ noteId: 'note-1', includeMetadata: true })
    expect(api.notes.exportPdf).toHaveBeenCalledWith({ noteId: 'note-1', includeMetadata: true })

    await notesService.getFolderConfig('projects')
    expect(api.notes.getFolderConfig).toHaveBeenCalledWith('projects')

    const config = { template: 'default', inherit: true }
    await notesService.setFolderConfig('projects', config)
    expect(api.notes.setFolderConfig).toHaveBeenCalledWith('projects', config)

    await notesService.getFolderTemplate('projects')
    expect(api.notes.getFolderTemplate).toHaveBeenCalledWith('projects')

    await notesService.getVersions('note-1')
    expect(api.notes.getVersions).toHaveBeenCalledWith('note-1')

    await notesService.restoreVersion('snapshot-1')
    expect(api.notes.restoreVersion).toHaveBeenCalledWith('snapshot-1')
  })

  it('registers note event subscriptions', () => {
    const unsubscribe = vi.fn()
    api.onNoteCreated = vi.fn(() => unsubscribe)
    api.onNoteUpdated = vi.fn(() => unsubscribe)
    api.onNoteDeleted = vi.fn(() => unsubscribe)
    api.onNoteRenamed = vi.fn(() => unsubscribe)
    api.onNoteMoved = vi.fn(() => unsubscribe)
    api.onNoteExternalChange = vi.fn(() => unsubscribe)
    api.onTagsChanged = vi.fn(() => unsubscribe)
    api.onFolderConfigUpdated = vi.fn(() => unsubscribe)

    const createdHandler = vi.fn()
    const updatedHandler = vi.fn()
    const deletedHandler = vi.fn()
    const renamedHandler = vi.fn()
    const movedHandler = vi.fn()
    const externalHandler = vi.fn()

    expect(onNoteCreated(createdHandler)).toBe(unsubscribe)
    expect(api.onNoteCreated).toHaveBeenCalledWith(createdHandler)

    expect(onNoteUpdated(updatedHandler)).toBe(unsubscribe)
    // onNoteUpdated wraps the handler to normalize `changes` — see below.
    expect(api.onNoteUpdated).toHaveBeenCalledWith(expect.any(Function))

    expect(onNoteDeleted(deletedHandler)).toBe(unsubscribe)
    expect(api.onNoteDeleted).toHaveBeenCalledWith(deletedHandler)

    expect(onNoteRenamed(renamedHandler)).toBe(unsubscribe)
    expect(api.onNoteRenamed).toHaveBeenCalledWith(renamedHandler)

    expect(onNoteMoved(movedHandler)).toBe(unsubscribe)
    expect(api.onNoteMoved).toHaveBeenCalledWith(movedHandler)

    expect(onNoteExternalChange(externalHandler)).toBe(unsubscribe)
    expect(api.onNoteExternalChange).toHaveBeenCalledWith(externalHandler)

    expect(onTagsChanged(createdHandler)).toBe(unsubscribe)
    expect(api.onTagsChanged).toHaveBeenCalledWith(createdHandler)

    expect(onFolderConfigUpdated(updatedHandler)).toBe(unsubscribe)
    expect(api.onFolderConfigUpdated).toHaveBeenCalledWith(updatedHandler)
  })

  describe('onNoteUpdated payload normalization', () => {
    // Regression: the sync path shipped `{ id, source: 'sync' }` with no
    // `changes` for months. Subscribers read `changes.content` unguarded, so
    // every pulled note threw inside the preload listener loop and the
    // subscriber silently missed the event.
    it('substitutes an empty changes object when the emitter omits it', () => {
      let emit: ((event: unknown) => void) | undefined
      api.onNoteUpdated = vi.fn((cb: (event: unknown) => void) => {
        emit = cb
        return vi.fn()
      })

      const handler = vi.fn()
      onNoteUpdated(handler)
      emit?.({ id: 'note-1', source: 'sync' })

      expect(handler).toHaveBeenCalledWith({ id: 'note-1', source: 'sync', changes: {} })
      expect(() => handler.mock.calls[0][0].changes.content).not.toThrow()
    })

    it('passes a well-formed payload through untouched', () => {
      let emit: ((event: unknown) => void) | undefined
      api.onNoteUpdated = vi.fn((cb: (event: unknown) => void) => {
        emit = cb
        return vi.fn()
      })

      const payload = { id: 'note-1', changes: { content: 'hello' }, source: 'sync' }
      const handler = vi.fn()
      onNoteUpdated(handler)
      emit?.(payload)

      expect(handler).toHaveBeenCalledWith(payload)
    })
  })

  describe('position operations', () => {
    it('getPositions forwards folder path to api', async () => {
      const positionsResponse = {
        success: true,
        positions: {
          'projects/note1.md': 0,
          'projects/note2.md': 1
        }
      }
      api.notes.getPositions = vi.fn().mockResolvedValue(positionsResponse)

      const result = await notesService.getPositions('projects')

      expect(api.notes.getPositions).toHaveBeenCalledWith('projects')
      expect(result).toEqual(positionsResponse)
    })

    it('getPositions handles root folder', async () => {
      const positionsResponse = {
        success: true,
        positions: {
          'root-note.md': 0
        }
      }
      api.notes.getPositions = vi.fn().mockResolvedValue(positionsResponse)

      const result = await notesService.getPositions('')

      expect(api.notes.getPositions).toHaveBeenCalledWith('')
      expect(result).toEqual(positionsResponse)
    })

    it('getAllPositions returns position map', async () => {
      const response = {
        success: true,
        positions: {
          'projects/note1.md': 0,
          'projects/note2.md': 1,
          'archive/old.md': 0
        }
      }
      api.notes.getAllPositions = vi.fn().mockResolvedValue(response)

      const result = await notesService.getAllPositions()

      expect(api.notes.getAllPositions).toHaveBeenCalled()
      expect(result).toEqual(response)
    })

    it('getAllPositions handles error response', async () => {
      const errorResponse = {
        success: false,
        positions: {},
        error: 'Database error'
      }
      api.notes.getAllPositions = vi.fn().mockResolvedValue(errorResponse)

      const result = await notesService.getAllPositions()

      expect(result.success).toBe(false)
      expect(result.error).toBe('Database error')
    })

    it('reorder forwards folder path and note paths to api', async () => {
      api.notes.reorder = vi.fn().mockResolvedValue({ success: true })

      const result = await notesService.reorder('projects', [
        'projects/note2.md',
        'projects/note1.md',
        'projects/note3.md'
      ])

      expect(api.notes.reorder).toHaveBeenCalledWith('projects', [
        'projects/note2.md',
        'projects/note1.md',
        'projects/note3.md'
      ])
      expect(result).toEqual({ success: true })
    })

    it('reorder handles error response', async () => {
      const errorResponse = { success: false, error: 'Reorder failed' }
      api.notes.reorder = vi.fn().mockResolvedValue(errorResponse)

      const result = await notesService.reorder('projects', ['projects/note1.md'])

      expect(result.success).toBe(false)
      expect(result.error).toBe('Reorder failed')
    })
  })
})
