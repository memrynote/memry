import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { answer, current } from '@/lib/permanent-delete-question'
import { getI18n } from 'react-i18next'

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
  notesGetUnlinkedMentions: vi.fn(),
  notesLinkMention: vi.fn(),
  notesEditAliases: vi.fn(),
  tagsGetAllWithCounts: vi.fn(),
  notesPreviewByTitle: vi.fn(),
  notesSetLocalOnly: vi.fn(),
  notesGetLocalOnlyCount: vi.fn(),
  notesGetPropertyDefinitions: vi.fn(),
  notesCreatePropertyDefinition: vi.fn(),
  notesUpdatePropertyDefinition: vi.fn(),
  notesAddStatusOption: vi.fn(),
  notesRename: vi.fn(),
  notesUpdate: vi.fn(),
  notesApplyTemplate: vi.fn(),
  notesUndoTagTemplate: vi.fn(),
  notesMove: vi.fn(),
  notesReorder: vi.fn(),
  notesGetAllPositions: vi.fn(),
  notesGetFolders: vi.fn(),
  notesCreateFolder: vi.fn(),
  notesRenameFolder: vi.fn(),
  notesDeleteFolder: vi.fn(),
  notesGetFolderConfig: vi.fn(),
  notesSetFolderConfig: vi.fn(),
  notesGetFolderTemplate: vi.fn()
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
    noteRenamedEvent: event('renamed'),
    noteMovedEvent: event('moved'),
    noteTagsChangedEvent: event('tags'),
    noteEventsDroppedEvent: event('dropped')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))
const toast = vi.hoisted(() => ({ warning: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

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

  it('reads unlinked mentions and a link card from Rust, the card opening from its body', async () => {
    const mention = {
      sourceId: 'note-2',
      sourcePath: 'Standup.md',
      sourceTitle: 'Standup',
      contexts: [{ snippet: 'the Plan today', linkStart: 4, linkEnd: 8 }],
      mentionCount: 1,
      truncated: false
    }
    commands.notesGetUnlinkedMentions.mockResolvedValue([mention])
    const card = {
      id: 'note-1',
      title: 'Plan',
      emoji: null,
      snippet: 'Goals',
      tags: [{ name: 'work', color: 'stone' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      matchedName: 'Roadmap',
      path: 'Plan.md',
      cover: null,
      description: null
    }
    commands.notesPreviewByTitle
      .mockResolvedValueOnce({ ...card, body: '# Goals\n\n- [ ] ship **it**' })
      .mockResolvedValueOnce({ ...card, description: 'Why', body: null })
      .mockResolvedValueOnce(null)

    expect(await notesService.getUnlinkedMentions('note-1')).toEqual([mention])
    expect(commands.notesGetUnlinkedMentions).toHaveBeenCalledWith('note-1')
    expect(await notesService.previewByTitle('Roadmap')).toEqual({
      ...card,
      bodyText: 'Goals ship it'
    })
    expect(await notesService.previewByTitle('Roadmap')).toEqual({
      ...card,
      description: 'Why',
      bodyText: null
    })
    expect(await notesService.previewByTitle('Gone')).toBeNull()
    expect(api.notes.getUnlinkedMentions).not.toHaveBeenCalled()
    expect(api.notes.previewByTitle).not.toHaveBeenCalled()
  })

  it("links a mention through its command, in Electron's answer", async () => {
    api.notes.linkMention = vi.fn()
    commands.notesLinkMention.mockResolvedValueOnce(true).mockResolvedValueOnce(false)

    const input = { sourceId: 'note-2', targetId: 'note-1', ordinal: 1 }
    expect(await notesService.linkMention(input)).toEqual({ linked: true })
    expect(commands.notesLinkMention).toHaveBeenCalledWith('note-2', 'note-1', 1)
    expect(await notesService.linkMention(input)).toEqual({ linked: false })
    commands.notesLinkMention.mockRejectedValueOnce({ kind: 'NotFound', message: 'gone' })
    await expect(notesService.linkMention(input)).rejects.toEqual({
      kind: 'NotFound',
      message: 'gone'
    })
    expect(api.notes.linkMention).not.toHaveBeenCalled()
  })

  it("edits a note's other names through its command, rejecting a failure", async () => {
    api.notes.editAliases = vi.fn()
    commands.notesEditAliases.mockResolvedValueOnce({ aliases: ['AGI'] })

    const input = { id: 'note-1', add: ['AGI'], remove: ['AI'] }
    expect(await notesService.editAliases(input)).toEqual({ aliases: ['AGI'] })
    expect(commands.notesEditAliases).toHaveBeenCalledWith(input)
    commands.notesEditAliases.mockRejectedValueOnce({ kind: 'propertyWrite', code: 'kept' })
    await expect(notesService.editAliases(input)).rejects.toEqual({
      kind: 'propertyWrite',
      code: 'kept'
    })
    expect(api.notes.editAliases).not.toHaveBeenCalled()
  })

  it("reads the tag list from the tags command, in Electron's notes:get-tags shape", async () => {
    api.notes.getTags = vi.fn()
    commands.tagsGetAllWithCounts.mockResolvedValue([
      { name: 'work', count: 3, color: 'blue', icon: null, categoryId: 'c1', sortOrder: 2 }
    ])

    expect(await notesService.getTags()).toEqual([{ tag: 'work', color: 'blue', count: 3 }])
    expect(api.notes.getTags).not.toHaveBeenCalled()
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
    expect(commands.notesCreate).toHaveBeenCalledWith({
      ...input,
      template: undefined,
      emoji: undefined
    })
    expect(created.success).toBe(true)
    expect(created.note?.modified).toEqual(new Date(MODIFIED))
    expect(await notesService.delete('note-1')).toEqual({ success: true })
    expect(commands.notesDelete).toHaveBeenCalledWith('note-1', null)

    // A template and a cleared icon reach the command as asked.
    await notesService.create({ title: 'T', template: 'weekly', emoji: null })
    expect(commands.notesCreate).toHaveBeenLastCalledWith({
      title: 'T',
      content: undefined,
      folder: undefined,
      tags: undefined,
      properties: undefined,
      template: 'weekly',
      emoji: null
    })
    // Plain checklists (Step 32) would be dropped, so the create is refused.
    await expect(notesService.create({ title: 'T', plainChecklists: true })).rejects.toMatchObject({
      name: 'NotPortedError'
    })
    expect(commands.notesCreate).toHaveBeenCalledTimes(2)
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
    api.notes.getCarriedTasks = vi.fn().mockResolvedValue({ taskIds: [] })

    await notesService.getCarriedTasks({ noteIds: ['n1'] })
    expect(api.notes.getCarriedTasks).toHaveBeenCalledWith({ noteIds: ['n1'] })
  })

  it("reads and writes folders through their commands, a failure in Electron's shape", async () => {
    commands.notesGetFolders.mockResolvedValue([{ path: 'Work', icon: null }])
    await expect(notesService.getFolders()).resolves.toEqual([{ path: 'Work', icon: null }])

    commands.notesCreateFolder.mockResolvedValueOnce(null)
    await expect(notesService.createFolder('Work/Plans')).resolves.toEqual({ success: true })
    expect(commands.notesCreateFolder).toHaveBeenCalledWith('Work/Plans')
    commands.notesCreateFolder.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'name_conflict',
      message: 'taken'
    })
    await expect(notesService.createFolder('Work')).resolves.toEqual({
      success: false,
      error: 'taken'
    })

    commands.notesRenameFolder.mockResolvedValueOnce(null)
    await expect(notesService.renameFolder('Work', 'Archive/Work')).resolves.toEqual({
      success: true
    })
    expect(commands.notesRenameFolder).toHaveBeenCalledWith('Work', 'Archive/Work')
    commands.notesRenameFolder.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'folder_holds_journal',
      message: 'the journal'
    })
    await expect(notesService.renameFolder('Work', 'Else')).resolves.toEqual({
      success: false,
      error: 'the journal'
    })

    commands.notesDeleteFolder.mockResolvedValueOnce(null)
    await expect(notesService.deleteFolder('Work')).resolves.toEqual({ success: true })
    expect(commands.notesDeleteFolder).toHaveBeenCalledWith('Work')
    // Electron's text for any failed folder delete; the command's reason stays in the log.
    commands.notesDeleteFolder.mockRejectedValueOnce({
      kind: 'storage',
      code: 'note_trash_unavailable',
      message: 'no bin'
    })
    await expect(notesService.deleteFolder('Work')).resolves.toEqual({
      success: false,
      error: getI18n().t('errors:folder.deleteFailed')
    })

    commands.notesGetFolderConfig.mockResolvedValueOnce({
      icon: 'lucide:folder',
      template: null,
      inherit: false,
      views: [{ id: 'v1' }]
    })
    await expect(notesService.getFolderConfig('Work')).resolves.toEqual({
      icon: 'lucide:folder',
      template: undefined,
      inherit: false,
      views: [{ id: 'v1' }]
    })
    commands.notesGetFolderConfig.mockResolvedValueOnce(null)
    await expect(notesService.getFolderConfig('Gone')).resolves.toBeNull()

    const config = { template: 'daily', inherit: true }
    commands.notesSetFolderConfig.mockResolvedValueOnce(null)
    await expect(notesService.setFolderConfig('Work', config)).resolves.toEqual({
      success: true
    })
    expect(commands.notesSetFolderConfig).toHaveBeenCalledWith('Work', config)
    commands.notesSetFolderConfig.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'folder_file_unreadable',
      message: 'unreadable'
    })
    await expect(notesService.setFolderConfig('Work', config)).resolves.toEqual({
      success: false,
      error: 'unreadable'
    })

    commands.notesGetFolderTemplate.mockResolvedValue('daily')
    await expect(notesService.getFolderTemplate('Work/Plans')).resolves.toBe('daily')
    expect(commands.notesGetFolderTemplate).toHaveBeenCalledWith('Work/Plans')
  })

  it("edits through its command, a failure in Electron's shape", async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({ note: view })
    const headerTags = { add: ['idea'], source: 'inline' as const }
    await expect(
      notesService.update({ id: 'note-1', content: 'Body', headerTags, emoji: null })
    ).resolves.toEqual({
      success: true,
      note: { ...view, created: new Date(CREATED), modified: new Date(MODIFIED) }
    })
    expect(commands.notesUpdate).toHaveBeenCalledWith({
      id: 'note-1',
      content: 'Body',
      headerTags,
      emoji: null
    })

    commands.notesUpdate.mockRejectedValue({
      kind: 'storage',
      code: 'note_file_failed',
      message: 'the file changed while it was being written'
    })
    await expect(notesService.update({ id: 'note-1', content: 'Other' })).resolves.toEqual({
      success: false,
      error: 'the file changed while it was being written',
      note: null
    })
  })

  it("hands on a tag's template outcome and undoes it through its command", async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    const tagTemplate = { kind: 'applied' as const, tag: 'meeting', undoToken: 'tok' }
    commands.notesUpdate.mockResolvedValue({ note: view, tagTemplate })
    const result = await notesService.update({ id: 'note-1', headerTags: { add: ['meeting'] } })
    expect(result).toMatchObject({ success: true, tagTemplate })

    commands.notesUndoTagTemplate.mockResolvedValue('stale')
    await expect(
      notesService.undoTagTemplate({ noteId: 'note-1', undoToken: 'tok' })
    ).resolves.toEqual({ status: 'stale' })
    expect(commands.notesUndoTagTemplate).toHaveBeenCalledWith({
      noteId: 'note-1',
      undoToken: 'tok'
    })
  })

  it('refuses the edits later steps port rather than drop them', async () => {
    await expect(notesService.update({ id: 'note-1', title: 'Renamed' })).rejects.toThrow(
      'notes.update({ title }) is not ported'
    )
    await expect(
      notesService.update({ id: 'note-1', frontmatter: { fullWidth: true } })
    ).rejects.toThrow('notes.update({ frontmatter }) is not ported')
    expect(commands.notesUpdate).not.toHaveBeenCalled()
    expect(api.notes.update).not.toHaveBeenCalled()
  })

  it("applies a template through its command, a failure in Electron's shape", async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesApplyTemplate.mockResolvedValue(view)
    const input = { noteId: 'note-1', templateId: 'blank', mode: 'full' as const }
    await expect(notesService.applyTemplate(input)).resolves.toEqual({
      success: true,
      note: { ...view, created: new Date(CREATED), modified: new Date(MODIFIED) }
    })
    expect(commands.notesApplyTemplate).toHaveBeenCalledWith(input)

    commands.notesApplyTemplate.mockRejectedValue({
      kind: 'NotFound',
      code: 'template_not_found',
      message: 'template not found: blank'
    })
    await expect(notesService.applyTemplate({ ...input, mode: 'body' })).resolves.toEqual({
      success: false,
      error: 'template not found: blank',
      note: null
    })

    commands.notesApplyTemplate.mockClear()
    await expect(notesService.applyTemplate({ ...input, plainChecklists: true })).rejects.toThrow(
      'notes.applyTemplate({ plainChecklists }) is not ported'
    )
    expect(commands.notesApplyTemplate).not.toHaveBeenCalled()
  })

  it("renames through its command, a failure in Electron's shape", async () => {
    const view = {
      id: 'note-1',
      path: 'Renamed.md',
      title: 'Renamed',
      created: CREATED,
      modified: MODIFIED
    }
    commands.notesRename.mockResolvedValue(view)
    await expect(notesService.rename('note-1', 'Renamed')).resolves.toEqual({
      success: true,
      note: { ...view, created: new Date(CREATED), modified: new Date(MODIFIED) }
    })
    expect(commands.notesRename).toHaveBeenCalledWith('note-1', 'Renamed')

    commands.notesRename.mockRejectedValue({
      kind: 'invalid',
      code: 'name_conflict',
      message: 'taken'
    })
    await expect(notesService.rename('note-1', 'Other')).resolves.toEqual({
      success: false,
      error: 'taken',
      note: null
    })
  })

  it("moves through its command, a failure in Electron's shape", async () => {
    const view = {
      id: 'note-1',
      path: 'archive/Plan.md',
      title: 'Plan',
      created: CREATED,
      modified: MODIFIED
    }
    commands.notesMove.mockResolvedValue({ note: view, refsKept: null })
    await expect(notesService.move('note-1', 'archive')).resolves.toEqual({
      success: true,
      note: { ...view, created: new Date(CREATED), modified: new Date(MODIFIED) }
    })
    expect(commands.notesMove).toHaveBeenCalledWith('note-1', 'archive')
    expect(toast.warning).not.toHaveBeenCalled()

    commands.notesMove.mockRejectedValue({
      kind: 'invalid',
      code: 'invalid_folder',
      message: 'not a folder of the vault'
    })
    await expect(notesService.move('note-1', '.git')).resolves.toEqual({
      success: false,
      error: 'not a folder of the vault',
      note: null
    })
  })

  it('moves a note whose refs stayed, and tells the user why', async () => {
    const view = { id: 'note-1', path: 'archive/Plan.md', title: 'Plan', created: 0, modified: 0 }
    for (const refsKept of ['changing', 'unreadable']) {
      toast.warning.mockClear()
      commands.notesMove.mockResolvedValue({ note: view, refsKept })
      await expect(notesService.move('note-1', 'archive')).resolves.toMatchObject({
        success: true,
        note: { path: 'archive/Plan.md' }
      })
      expect(toast.warning).toHaveBeenCalledOnce()
      expect(toast.warning.mock.calls[0]?.[0]).toContain('Plan')
    }
    expect(toast.warning.mock.calls[0]?.[0]).toMatch(/by hand/)
    toast.warning.mock.calls[0]?.[1]?.onDismiss?.()
  })

  it('sums up the notes of a bulk move whose refs stayed in one warning', async () => {
    toast.warning.mockClear()
    const view = (id: string, title: string) => ({
      id,
      path: `archive/${title}.md`,
      title,
      created: 0,
      modified: 0
    })
    commands.notesMove
      .mockResolvedValueOnce({ note: view('a', 'Plan'), refsKept: 'changing' })
      .mockResolvedValueOnce({ note: view('b', 'Kept'), refsKept: null })
      .mockResolvedValueOnce({ note: view('c', 'Ideas'), refsKept: 'unreadable' })
      .mockResolvedValueOnce({ note: view('d', 'Later'), refsKept: 'changing' })
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => notesService.move(id, 'archive')))

    const calls = toast.warning.mock.calls
    expect(calls).toHaveLength(3)
    const [first] = calls
    expect(first?.[1]?.id).toBeTruthy()
    expect(calls.every(([, options]) => options?.id === first?.[1]?.id)).toBe(true)
    expect(first?.[0]).toContain('Plan')
    expect(calls.at(-1)?.[0]).toMatch(/^3 notes moved/)

    // A note whose file Memry cannot edit keeps "by hand" in the summary.
    expect(calls.at(-1)?.[0]).toMatch(/by hand/)

    // Once it closed, the next move's warning names its note again, and a batch of notes that
    // were only changing is told to check them.
    calls.at(-1)?.[1]?.onAutoClose?.()
    commands.notesMove.mockResolvedValueOnce({ note: view('e', 'Solo'), refsKept: 'changing' })
    await notesService.move('e', 'archive')
    expect(calls.at(-1)?.[0]).toContain('Solo')
    commands.notesMove.mockResolvedValueOnce({ note: view('f', 'Duo'), refsKept: 'changing' })
    await notesService.move('f', 'archive')
    expect(calls.at(-1)?.[0]).toMatch(/^2 notes moved/)
    expect(calls.at(-1)?.[0]).toMatch(/Check them in each note/)
    calls.at(-1)?.[1]?.onDismiss?.()
  })

  it('forwards attachments, export, and version helpers', async () => {
    api.notes.uploadAttachment = vi.fn().mockResolvedValue({ success: true })
    api.notes.exportPdf = vi.fn().mockResolvedValue({ success: true })
    api.notes.getVersions = vi.fn().mockResolvedValue([])
    api.notes.restoreVersion = vi.fn().mockResolvedValue({ success: true })

    const file = new File(['data'], 'note.txt', { type: 'text/plain' })
    await notesService.uploadAttachment('note-1', file)
    expect(api.notes.uploadAttachment).toHaveBeenCalledWith('note-1', file)

    await notesService.exportPdf({ noteId: 'note-1', includeMetadata: true })
    expect(api.notes.exportPdf).toHaveBeenCalledWith({ noteId: 'note-1', includeMetadata: true })

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

  it('hands on a rename from Rust as it comes', async () => {
    const renamed = vi.fn()
    const stop = onNoteRenamed(renamed)
    await vi.waitFor(() => expect(listeners.has('renamed')).toBe(true))
    const payload = {
      id: 'n',
      oldPath: 'plan.md',
      newPath: 'Plan.md',
      oldTitle: 'plan',
      newTitle: 'Plan'
    }
    listeners.get('renamed')?.({ payload })
    expect(renamed).toHaveBeenCalledWith(payload)
    stop()
    await vi.waitFor(() => expect(listeners.has('renamed')).toBe(false))
  })

  it('hands on a move from Rust as it comes', async () => {
    const moved = vi.fn()
    const stop = onNoteMoved(moved)
    await vi.waitFor(() => expect(listeners.has('moved')).toBe(true))
    const payload = { id: 'n', oldPath: 'work/Plan.md', newPath: 'archive/Plan.md' }
    listeners.get('moved')?.({ payload })
    expect(moved).toHaveBeenCalledWith(payload)
    stop()
    await vi.waitFor(() => expect(listeners.has('moved')).toBe(false))
  })

  it('registers the note event subscriptions not yet ported on window.api', () => {
    const unsubscribe = vi.fn()
    api.onNoteExternalChange = vi.fn(() => unsubscribe)
    api.onFolderConfigUpdated = vi.fn(() => unsubscribe)
    const handler = vi.fn()

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

    it('reads every slot and reorders through the commands', async () => {
      commands.notesGetAllPositions.mockResolvedValue({ 'b.md': 0, 'a.md': 1 })
      await expect(notesService.getAllPositions()).resolves.toEqual({
        success: true,
        positions: { 'b.md': 0, 'a.md': 1 }
      })

      commands.notesReorder.mockResolvedValue(null)
      await expect(
        notesService.reorder('projects', ['projects/b.md', 'projects/a.md'])
      ).resolves.toEqual({
        success: true
      })
      expect(commands.notesReorder).toHaveBeenCalledWith('projects', [
        'projects/b.md',
        'projects/a.md'
      ])
    })

    it("answers a failed read or reorder in Electron's shape", async () => {
      const refusal = { kind: 'invalid', code: 'no_vault_open', message: 'No vault is open' }
      commands.notesGetAllPositions.mockRejectedValue(refusal)
      await expect(notesService.getAllPositions()).resolves.toEqual({
        success: false,
        positions: {},
        error: 'No vault is open'
      })
      commands.notesReorder.mockRejectedValue(refusal)
      await expect(notesService.reorder('projects', [])).resolves.toEqual({
        success: false,
        error: 'No vault is open'
      })
    })
  })
})
