import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteRenamed,
  onNoteMoved,
  onNoteExternalChange
} from './notes-service'

describe('notes-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('exposes note RPC methods directly from window.api.notes', () => {
    expect(notesService.create).toBe(api.notes.create)
    expect(notesService.get).toBe(api.notes.get)
    expect(notesService.list).toBe(api.notes.list)
    expect(notesService.uploadAttachment).toBe(api.notes.uploadAttachment)
    expect(notesService.reorder).toBe(api.notes.reorder)
  })

  it('forwards core note operations to window.api.notes', async () => {
    const createResponse = { success: true, note: { id: 'note-1' } }
    api.notes.create = vi.fn().mockResolvedValue(createResponse)
    api.notes.get = vi.fn().mockResolvedValue({ id: 'note-1' })
    api.notes.update = vi.fn().mockResolvedValue({ success: true })
    api.notes.rename = vi.fn().mockResolvedValue({ success: true })
    api.notes.list = vi.fn().mockResolvedValue({ notes: [], total: 0, hasMore: false })

    const createInput = { title: 'New note', content: 'Hello' }
    const createResult = await notesService.create(createInput)
    expect(api.notes.create).toHaveBeenCalledWith(createInput)
    expect(createResult).toEqual(createResponse)

    const getResult = await notesService.get('note-1')
    expect(api.notes.get).toHaveBeenCalledWith('note-1')
    expect(getResult).toEqual({ id: 'note-1' })

    const updateInput = { id: 'note-1', title: 'Updated' }
    await notesService.update(updateInput)
    expect(api.notes.update).toHaveBeenCalledWith(updateInput)

    await notesService.rename('note-1', 'Renamed')
    expect(api.notes.rename).toHaveBeenCalledWith('note-1', 'Renamed')

    await notesService.list({ folder: 'projects', limit: 5 })
    expect(api.notes.list).toHaveBeenCalledWith({ folder: 'projects', limit: 5 })
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

    const createdHandler = vi.fn()
    const updatedHandler = vi.fn()
    const deletedHandler = vi.fn()
    const renamedHandler = vi.fn()
    const movedHandler = vi.fn()
    const externalHandler = vi.fn()

    expect(onNoteCreated(createdHandler)).toBe(unsubscribe)
    expect(api.onNoteCreated).toHaveBeenCalledWith(createdHandler)

    expect(onNoteUpdated(updatedHandler)).toBe(unsubscribe)
    expect(api.onNoteUpdated).toHaveBeenCalledWith(updatedHandler)

    expect(onNoteDeleted(deletedHandler)).toBe(unsubscribe)
    expect(api.onNoteDeleted).toHaveBeenCalledWith(deletedHandler)

    expect(onNoteRenamed(renamedHandler)).toBe(unsubscribe)
    expect(api.onNoteRenamed).toHaveBeenCalledWith(renamedHandler)

    expect(onNoteMoved(movedHandler)).toBe(unsubscribe)
    expect(api.onNoteMoved).toHaveBeenCalledWith(movedHandler)

    expect(onNoteExternalChange(externalHandler)).toBe(unsubscribe)
    expect(api.onNoteExternalChange).toHaveBeenCalledWith(externalHandler)
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
