import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { answer, current } from '@/lib/permanent-delete-question'

const commands = vi.hoisted(() => ({
  notesCreate: vi.fn(),
  notesDelete: vi.fn(),
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
  notesResolveWikiTarget: vi.fn(),
  notesSetLocalOnly: vi.fn(),
  notesGetLocalOnlyCount: vi.fn(),
  notesGetPropertyDefinitions: vi.fn(),
  notesCreatePropertyDefinition: vi.fn(),
  notesUpdatePropertyDefinition: vi.fn(),
  notesAddStatusOption: vi.fn()
}))

// Each Rust event's last listener, for a test to send a payload through.
const listeners = vi.hoisted(() => new Map<string, (event: { payload: unknown }) => void>())
const events = vi.hoisted(() => {
  const event = (name: string) => ({
    listen: async (handler: (event: { payload: unknown }) => void) => {
      listeners.set(name, handler)
      return () => listeners.delete(name)
    }
  })
  return {
    noteCreatedEvent: event('created'),
    noteUpdatedEvent: event('updated'),
    noteDeletedEvent: event('deleted'),
    noteTagsChangedEvent: event('tags'),
    noteEventsDroppedEvent: event('dropped')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))

import {
  notesService,
  onNoteCreated,
  onNoteUpdated,
  onNoteDeleted,
  onNoteEventsDropped,
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

  it('creates and deletes through the commands, rejecting what it cannot create yet', async () => {
    commands.notesCreate.mockResolvedValue({
      id: 'note-1',
      path: 'work/Plan.md',
      title: 'Plan',
      content: 'Hello',
      frontmatter: {},
      created: CREATED,
      modified: MODIFIED,
      tags: ['alpha'],
      headerTags: ['alpha'],
      aliases: [],
      wordCount: 1,
      properties: { status: 'open' },
      emoji: null,
      localOnly: false,
      sizeClass: 'note',
      largeFile: null,
      contentOmitted: false
    })
    commands.notesDelete.mockResolvedValue(null)

    const input = {
      title: 'Plan',
      content: 'Hello',
      folder: 'work',
      tags: ['alpha'],
      properties: { status: 'open' }
    }
    const created = await notesService.create(input)
    expect(commands.notesCreate).toHaveBeenCalledWith({ ...input, emoji: undefined })
    expect(created.success).toBe(true)
    expect(created.note?.modified).toEqual(new Date(MODIFIED))
    expect(await notesService.delete('note-1')).toEqual({ success: true })
    expect(commands.notesDelete).toHaveBeenCalledWith('note-1', null)

    // A template (13l) or plain checklists (32) would be dropped, so the create is refused.
    await expect(notesService.create({ title: 'T', template: 'weekly' })).rejects.toMatchObject({
      name: 'NotPortedError'
    })
    await expect(notesService.create({ title: 'T', plainChecklists: true })).rejects.toMatchObject({
      name: 'NotPortedError'
    })
    expect(commands.notesCreate).toHaveBeenCalledTimes(1)
    // A failure answers as Electron's handler does, with the command's message.
    commands.notesDelete.mockRejectedValue({
      kind: 'not_found',
      code: 'note_not_found',
      message: 'note not found: gone'
    })
    expect(await notesService.delete('gone')).toEqual({
      success: false,
      error: 'note not found: gone'
    })
    commands.notesCreate.mockRejectedValue({
      kind: 'conflict',
      code: 'name_conflict',
      message: 'name taken'
    })
    expect(await notesService.create(input)).toEqual({
      success: false,
      note: null,
      error: 'name taken'
    })
    expect(api.notes.create).not.toHaveBeenCalled()
  })

  it('asks before a delete the trash refused goes for good, and deletes only on yes', async () => {
    const refused = { kind: 'storage', code: 'note_trash_unavailable', message: 'no trash' }
    commands.notesGet.mockResolvedValue({ id: 'n', title: 'Plan', created: 0, modified: 0 })
    const ask = async (permanent: boolean) => {
      commands.notesDelete.mockReset()
      commands.notesDelete.mockRejectedValueOnce(refused).mockResolvedValueOnce(null)
      const deleting = notesService.delete('n')
      await vi.waitFor(() => expect(current()).toMatchObject({ noteId: 'n', title: 'Plan' }))
      answer(current(), permanent)
      return deleting
    }

    expect(await ask(true)).toEqual({ success: true })
    expect(commands.notesDelete.mock.calls).toEqual([
      ['n', null],
      ['n', true]
    ])

    const kept = await ask(false)
    expect(kept.success).toBe(false)
    expect(kept.error).toEqual(expect.any(String))
    expect(commands.notesDelete.mock.calls).toEqual([['n', null]])

    // Any other failure is answered at once, with no question.
    commands.notesDelete.mockReset()
    commands.notesDelete.mockRejectedValueOnce({ ...refused, code: 'note_file_failed' })
    expect(await notesService.delete('n')).toEqual({ success: false, error: 'no trash' })
    expect(current()).toBeNull()

    // A note that cannot be read is not asked about: the refusal is the answer.
    for (const read of [() => Promise.resolve(null), () => Promise.reject(new Error('gone'))]) {
      commands.notesDelete.mockReset()
      commands.notesDelete.mockRejectedValueOnce(refused)
      commands.notesGet.mockImplementationOnce(read)
      expect(await notesService.delete('n')).toEqual({ success: false, error: 'no trash' })
      expect(current()).toBeNull()
      expect(commands.notesDelete).toHaveBeenCalledTimes(1)
    }
  })

  it('sets local-only through its command and rejects when the change did not happen', async () => {
    commands.notesSetLocalOnly.mockResolvedValueOnce({
      id: 'note-1',
      path: 'Plan.md',
      title: 'Plan',
      content: '',
      frontmatter: {},
      created: CREATED,
      modified: MODIFIED,
      tags: [],
      headerTags: [],
      aliases: [],
      wordCount: 0,
      properties: {},
      emoji: null,
      localOnly: true,
      sizeClass: 'note',
      largeFile: null,
      contentOmitted: false
    })
    const result = await notesService.setLocalOnly('note-1', true)
    expect(commands.notesSetLocalOnly).toHaveBeenCalledWith('note-1', true)
    expect(result.success).toBe(true)
    expect(result.note?.localOnly).toBe(true)
    expect(result.note?.modified).toEqual(new Date(MODIFIED))

    const tooLarge = { kind: 'sync', code: 'note_too_large_to_sync', message: 'too large' }
    commands.notesSetLocalOnly.mockRejectedValueOnce(tooLarge)
    await expect(notesService.setLocalOnly('note-1', false)).rejects.toEqual(tooLarge)

    commands.notesGetLocalOnlyCount.mockResolvedValue(3)
    expect(await notesService.getLocalOnlyCount()).toEqual({ count: 3 })
    expect(api.notes.setLocalOnly).not.toHaveBeenCalled()
    expect(api.notes.getLocalOnlyCount).not.toHaveBeenCalled()
  })

  it("writes property definitions through their commands, failures in Electron's shape", async () => {
    const stage = {
      name: 'Stage',
      type: 'select',
      options: '[]',
      defaultValue: '3',
      color: null,
      createdAt: ''
    }
    commands.notesCreatePropertyDefinition.mockResolvedValueOnce(stage)
    // A default value that is not text is sent as Electron's handler stores it.
    expect(
      await notesService.createPropertyDefinition({
        name: 'Stage',
        type: 'select',
        defaultValue: 3
      })
    ).toEqual({ success: true, definition: stage })
    expect(commands.notesCreatePropertyDefinition).toHaveBeenCalledWith({
      name: 'Stage',
      type: 'select',
      defaultValue: '3'
    })

    // A file that cannot be read: the localized reason, not the Rust text.
    const unreadable = {
      kind: 'propertyWrite',
      code: 'property_definitions_unreadable',
      message: 'x'
    }
    commands.notesCreatePropertyDefinition.mockRejectedValueOnce(unreadable)
    const refused = await notesService.createPropertyDefinition({ name: 'Stage', type: 'text' })
    expect(refused).toEqual({
      success: false,
      definition: null,
      error: expect.stringContaining('.memry/properties.md')
    })

    // A write that fails: the localized reason, without the Rust text and its vault path.
    commands.notesCreatePropertyDefinition.mockRejectedValueOnce({
      kind: 'storage',
      code: 'property_definitions_write_failed',
      message: 'the property definitions file /vault/.memry/properties.md cannot be written'
    })
    expect(await notesService.createPropertyDefinition({ name: 'Stage', type: 'text' })).toEqual({
      success: false,
      definition: null,
      error: "Can't save property changes because .memry/properties.md can't be written."
    })

    commands.notesUpdatePropertyDefinition.mockResolvedValueOnce(null)
    expect(await notesService.updatePropertyDefinition({ name: 'Missing' })).toEqual({
      success: false,
      definition: null,
      error: 'Definition not found'
    })

    commands.notesAddStatusOption.mockRejectedValueOnce(unreadable)
    await expect(
      notesService.addStatusOption('Status', 'todo', { value: 'Later', color: 'sky' })
    ).rejects.toEqual(unreadable)
    expect(api.notes.addStatusOption).not.toHaveBeenCalled()
  })

  it('forwards the methods later steps port to window.api.notes', async () => {
    api.notes.update = vi.fn().mockResolvedValue({ success: true })
    api.notes.rename = vi.fn().mockResolvedValue({ success: true })

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

  it('hands the note and tag-list events from Rust on in the renderer shape', async () => {
    const created = vi.fn()
    const updated = vi.fn()
    const deleted = vi.fn()
    const tagsChanged = vi.fn()
    const stops = [
      onNoteCreated(created),
      onNoteUpdated(updated),
      onNoteDeleted(deleted),
      onTagsChanged(tagsChanged)
    ]
    await vi.waitFor(() => expect(listeners.size).toBe(4))

    const note = { id: 'n', path: 'a.md', title: 'a', created: CREATED, modified: MODIFIED }
    listeners.get('created')?.({ payload: { note, source: 'internal' } })
    listeners.get('updated')?.({
      payload: { id: 'n', changes: { title: 'b', modified: MODIFIED }, source: 'external' }
    })
    listeners.get('deleted')?.({ payload: { id: 'n', path: 'a.md', source: 'internal' } })
    listeners.get('tags')?.({ payload: null })

    expect(created).toHaveBeenCalledWith({
      note: { ...note, created: new Date(CREATED), modified: new Date(MODIFIED) },
      source: 'internal'
    })
    // `modified` is a `Date`, as every `Note` date the renderer reads.
    expect(updated).toHaveBeenCalledWith({
      id: 'n',
      changes: { title: 'b', modified: new Date(MODIFIED) },
      source: 'external'
    })
    expect(deleted).toHaveBeenCalledWith({ id: 'n', path: 'a.md', source: 'internal' })
    // `notes:tags-changed` carries nothing the renderer reads.
    expect(tagsChanged).toHaveBeenCalledWith()
    for (const stop of stops) stop()
    await vi.waitFor(() => expect(listeners.size).toBe(0))
  })

  it('hands on the signal that note events were dropped', async () => {
    const dropped = vi.fn()
    const stop = onNoteEventsDropped(dropped)
    await vi.waitFor(() => expect(listeners.has('dropped')).toBe(true))
    listeners.get('dropped')?.({ payload: null })
    expect(dropped).toHaveBeenCalledTimes(1)
    stop()
    await vi.waitFor(() => expect(listeners.has('dropped')).toBe(false))
  })

  it('registers the note event subscriptions not yet ported on window.api', () => {
    const unsubscribe = vi.fn()
    api.onNoteRenamed = vi.fn(() => unsubscribe)
    api.onNoteMoved = vi.fn(() => unsubscribe)
    api.onNoteExternalChange = vi.fn(() => unsubscribe)
    api.onFolderConfigUpdated = vi.fn(() => unsubscribe)
    const handler = vi.fn()

    expect(onNoteRenamed(handler)).toBe(unsubscribe)
    expect(api.onNoteRenamed).toHaveBeenCalledWith(handler)
    expect(onNoteMoved(handler)).toBe(unsubscribe)
    expect(api.onNoteMoved).toHaveBeenCalledWith(handler)
    expect(onNoteExternalChange(handler)).toBe(unsubscribe)
    expect(api.onNoteExternalChange).toHaveBeenCalledWith(handler)
    expect(onFolderConfigUpdated(handler)).toBe(unsubscribe)
    expect(api.onFolderConfigUpdated).toHaveBeenCalledWith(handler)
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
