import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { invoke } from '@/lib/ipc/invoke'
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
import { subscribeEvent } from '@/lib/ipc/forwarder'

describe('notes-service', () => {
  let api: ReturnType<typeof createMockApi>

  beforeEach(() => {
    vi.clearAllMocks()
    api = createMockApi()
    ;(window as Window & { api: unknown }).api = api
  })

  it('exposes note RPC methods as callable forwarders', () => {
    // Phase H: forwarder is a Proxy, so methods are not identical references.
    // Behavioural forwarding is covered by the dedicated tests below.
    expect(typeof notesService.create).toBe('function')
    expect(typeof notesService.get).toBe('function')
    expect(typeof notesService.list).toBe('function')
    expect(typeof notesService.uploadAttachment).toBe('function')
    expect(typeof notesService.reorder).toBe('function')
  })

  it('forwards core note operations through real Tauri payloads', async () => {
    const createResponse = { success: true, note: { id: 'note-1' } }
    api.notes.create = vi.fn().mockResolvedValue(createResponse)
    api.notes.get = vi.fn().mockResolvedValue({ id: 'note-1' })
    api.notes.update = vi.fn().mockResolvedValue({ success: true })
    api.notes.rename = vi.fn().mockResolvedValue({ success: true })
    api.notes.list = vi.fn().mockResolvedValue({ notes: [], total: 0, hasMore: false })

    const createInput = { title: 'New note', content: 'Hello' }
    const createResult = await notesService.create(createInput)
    expect(invoke).toHaveBeenCalledWith('notes_create', {
      title: 'New note',
      content: 'Hello',
      folder: null,
      tags: null,
      template: null
    })
    expect(createResult).toEqual(createResponse)

    const getResult = await notesService.get('note-1')
    expect(api.notes.get).toHaveBeenCalledWith('note-1')
    expect(getResult).toEqual({ id: 'note-1' })

    const updateInput = { id: 'note-1', title: 'Updated' }
    await notesService.update(updateInput)
    expect(invoke).toHaveBeenCalledWith('notes_update', {
      id: 'note-1',
      title: 'Updated',
      content: null,
      tags: null,
      frontmatter: null,
      emoji: null
    })

    await notesService.rename('note-1', 'Renamed')
    expect(api.notes.rename).toHaveBeenCalledWith('note-1', 'Renamed')

    await notesService.list({ folder: 'projects', limit: 5 })
    expect(api.notes.list).toHaveBeenCalledWith({ folder: 'projects', limit: 5 })
  })

  it('forwards explicit emoji clears through frontmatter patch', async () => {
    api.notes.update = vi.fn().mockResolvedValue({ success: true })

    await notesService.update({
      id: 'note-1',
      emoji: null,
      frontmatter: { fullWidth: true }
    })

    expect(invoke).toHaveBeenCalledWith('notes_update', {
      id: 'note-1',
      title: null,
      content: null,
      tags: null,
      frontmatter: { fullWidth: true, emoji: null },
      emoji: null
    })
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
    expect(invoke).toHaveBeenCalledWith('notes_set_folder_config', {
      input: { path: 'projects', icon: null, templateJson: 'default' }
    })

    await notesService.getFolderTemplate('projects')
    expect(api.notes.getFolderTemplate).toHaveBeenCalledWith('projects')

    await notesService.getVersions('note-1')
    expect(api.notes.getVersions).toHaveBeenCalledWith('note-1')

    await notesService.restoreVersion('snapshot-1')
    expect(api.notes.restoreVersion).toHaveBeenCalledWith('snapshot-1')
  })

  it('preserves existing folder icon when setting only a template', async () => {
    api.notes.getFolderConfig = vi.fn().mockResolvedValue({
      icon: 'folder-star',
      template: 'old-template'
    })
    api.notes.setFolderConfig = vi.fn().mockResolvedValue({ success: true })

    await notesService.setFolderConfig('projects', {
      template: 'new-template',
      inherit: true
    })

    expect(invoke).toHaveBeenCalledWith('notes_set_folder_config', {
      input: { path: 'projects', icon: 'folder-star', templateJson: 'new-template' }
    })
  })

  it('wraps ensurePropertyDefinition in the shared success response', async () => {
    const result = await notesService.ensurePropertyDefinition('status', 'status')

    expect(invoke).toHaveBeenCalledWith('notes_ensure_property_definition', {
      input: { name: 'status', type: 'status' }
    })
    expect(result).toEqual({ success: true })
  })

  it('registers note event subscriptions', () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.mocked(subscribeEvent)
    api.onNoteCreated = vi.fn(() => unsubscribe)
    api.onNoteUpdated = vi.fn(() => unsubscribe)
    api.onNoteDeleted = vi.fn(() => unsubscribe)
    api.onNoteRenamed = vi.fn(() => unsubscribe)
    api.onNoteMoved = vi.fn(() => unsubscribe)
    api.onNoteExternalChange = vi.fn(() => unsubscribe)
    api.onTagsChanged = vi.fn(() => unsubscribe)

    const createdHandler = vi.fn()
    const updatedHandler = vi.fn()
    const deletedHandler = vi.fn()
    const renamedHandler = vi.fn()
    const movedHandler = vi.fn()
    const externalHandler = vi.fn()
    const tagsHandler = vi.fn()
    const folderConfigHandler = vi.fn()

    expect(onNoteCreated(createdHandler)).toBe(unsubscribe)
    expect(api.onNoteCreated).toHaveBeenCalledTimes(1)

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

    onTagsChanged(tagsHandler)
    onFolderConfigUpdated(folderConfigHandler)

    expect(subscribe).toHaveBeenCalledWith('note-created', expect.any(Function))
    expect(subscribe).toHaveBeenCalledWith('note-updated', updatedHandler)
    expect(subscribe).toHaveBeenCalledWith('note-deleted', deletedHandler)
    expect(subscribe).toHaveBeenCalledWith('note-renamed', renamedHandler)
    expect(subscribe).toHaveBeenCalledWith('note-moved', movedHandler)
    expect(subscribe).toHaveBeenCalledWith('note-external-change', externalHandler)
    expect(subscribe).toHaveBeenCalledWith('tags-changed', tagsHandler)
    expect(subscribe).toHaveBeenCalledWith('folder-config-updated', folderConfigHandler)
  })

  it('revives created note event dates while preserving list-item shape', () => {
    api.onNoteCreated = vi.fn((handler) => {
      handler({
        note: {
          id: 'note-1',
          path: 'notes/Inbox/example.md',
          title: 'Example',
          created: '2026-04-27T00:00:00.000Z',
          modified: '2026-04-27T00:00:01.000Z',
          tags: ['next'],
          wordCount: 1,
          snippet: 'body',
          emoji: 'note',
          localOnly: false
        },
        source: 'internal'
      })
      return () => {}
    })

    const handler = vi.fn()
    onNoteCreated(handler)

    expect(handler).toHaveBeenCalledWith({
      note: {
        id: 'note-1',
        path: 'notes/Inbox/example.md',
        title: 'Example',
        created: new Date('2026-04-27T00:00:00.000Z'),
        modified: new Date('2026-04-27T00:00:01.000Z'),
        tags: ['next'],
        wordCount: 1,
        snippet: 'body',
        emoji: 'note',
        localOnly: false
      },
      source: 'internal'
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

      expect(invoke).toHaveBeenCalledWith('notes_reorder', {
        input: {
          folderPath: 'projects',
          notePaths: ['projects/note2.md', 'projects/note1.md', 'projects/note3.md']
        }
      })
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

  it('uses Tauri input envelopes for folder/property mutations', async () => {
    await notesService.deleteFolder('projects')
    expect(invoke).toHaveBeenCalledWith('notes_delete_folder', {
      input: { path: 'projects', recursive: true }
    })

    await notesService.ensurePropertyDefinition('status', 'status')
    expect(invoke).toHaveBeenCalledWith('notes_ensure_property_definition', {
      input: { name: 'status', type: 'status' }
    })

    await notesService.addPropertyOption('priority', { value: 'high', color: 'red' })
    expect(invoke).toHaveBeenCalledWith('notes_add_property_option', {
      input: { propertyName: 'priority', option: { value: 'high', color: 'red' } }
    })

    await notesService.deletePropertyDefinition('priority')
    expect(invoke).toHaveBeenCalledWith('notes_delete_property_definition', {
      input: { name: 'priority' }
    })
  })
})
