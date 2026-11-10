import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockApi } from '@tests/setup-dom'
import { answer, current } from '@/lib/permanent-delete-question'
import { getI18n } from 'react-i18next'
import { VAULT_LOCKED_FOLDER_MESSAGE } from '@memry/contracts/vault-locks-api'

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
  notesAppendBlocks: vi.fn(),
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
  notesGetFolderTemplate: vi.fn(),
  notesUploadAttachmentBegin: vi.fn(),
  notesUploadAttachmentAbort: vi.fn(),
  notesDownloadAttachmentFromUrl: vi.fn(),
  notesGetVersions: vi.fn(),
  notesGetVersion: vi.fn(),
  notesRestoreVersion: vi.fn(),
  notesDeleteVersion: vi.fn()
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
    folderConfigUpdatedEvent: event('folderConfig'),
    noteEventsDroppedEvent: event('dropped')
  }
})

vi.mock('../../../generated/bindings', () => ({ commands, events }))
const invokeBinary = vi.hoisted(() => vi.fn())
vi.mock('../lib/ipc-binary', () => ({ invokeBinary }))
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
    invokeBinary.mockReset()
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
    // A refusal says why (#3530).
    commands.notesDeleteFolder.mockRejectedValueOnce({
      kind: 'locked',
      code: 'note_excluded',
      message: 'This note is in an excluded folder.'
    })
    await expect(notesService.deleteFolder('Work')).resolves.toEqual({
      success: false,
      error: getI18n().t('errors:note.excluded')
    })
    commands.notesDeleteFolder.mockRejectedValueOnce({
      kind: 'locked',
      code: 'folder_locked',
      message: VAULT_LOCKED_FOLDER_MESSAGE
    })
    await expect(notesService.deleteFolder('Work')).resolves.toEqual({
      success: false,
      error: getI18n().t('errors:vaultLock.folderReadOnly')
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
      code: 'note_file_failed',
      note: null
    })
  })

  it('says when the save went over an outside edit the editor had no event for', async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({ note: view, keptOutsideEdit: true })
    const result = await notesService.update({ id: 'note-1', content: 'Typed' })
    expect(result).toMatchObject({ success: true, keptOutsideEdit: true })
  })

  it('names the body of the file the save replaced, which the core kept as a version', async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({
      note: view,
      keptOutsideEdit: false,
      keptReplacedHash: '0a1b2c3d'
    })
    const result = await notesService.update({ id: 'note-1', content: 'Typed' })
    expect(result).toMatchObject({ success: true, keptReplacedHash: '0a1b2c3d' })
  })

  // A save over an outside edit the editor never showed asks the core to keep it as a version,
  // and every save says which editor sent it (#4137).
  it('asks the core to keep the body a save replaces, and names the editor', async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({ note: view })
    await notesService.update({ id: 'note-1', content: 'Typed', keepReplaced: true, editor: 'e1' })
    expect(commands.notesUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'note-1', content: 'Typed', keepReplaced: true, editor: 'e1' })
    )
  })

  it('hands on the body the save wrote, which the note read after it may not hold', async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({ note: view, savedContent: '' })
    const result = await notesService.update({ id: 'note-1', content: '' })
    expect(result).toMatchObject({ success: true, savedContent: '' })
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

  it('hands named frontmatter keys, a removal as null, to its command', async () => {
    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesUpdate.mockResolvedValue({ note: view })
    const frontmatter = { coverFocus: 30, coverCredit: null }
    await expect(notesService.update({ id: 'note-1', frontmatter })).resolves.toMatchObject({
      success: true
    })
    expect(commands.notesUpdate).toHaveBeenCalledWith({ id: 'note-1', frontmatter })
    expect(api.notes.update).not.toHaveBeenCalled()
  })

  // Electron's update renames the record and leaves the file; `notes:rename` owns a title.
  it('refuses a title, which no caller sends', async () => {
    await expect(notesService.update({ id: 'note-1', title: 'Renamed' })).rejects.toThrow(
      'notes.update({ title }) is not ported'
    )
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

  // "Move to" removes the block from the source only on `success`: a refused move must answer
  // `success: false` with Rust's message, never resolve as moved.
  it('moves blocks through their command, a refusal answering not moved', async () => {
    const input = { sourceNoteId: 'note-1', targetNoteId: 'note-2', markdown: 'Relocate this line' }
    commands.notesAppendBlocks.mockResolvedValue({ targetPath: 'Target.md' })
    await expect(notesService.appendBlocks(input)).resolves.toEqual({
      success: true,
      targetPath: 'Target.md'
    })
    expect(commands.notesAppendBlocks).toHaveBeenCalledWith(input)

    commands.notesAppendBlocks.mockRejectedValue({
      kind: 'Locked',
      code: 'note_locked',
      message: 'The owner made this note read-only.'
    })
    await expect(notesService.appendBlocks(input)).resolves.toEqual({
      success: false,
      error: 'The owner made this note read-only.'
    })
  })

  it("reads, restores and deletes versions through their commands, a failure in Electron's shape", async () => {
    const version = {
      id: 'v-1',
      noteId: 'note-1',
      title: 'Plan',
      wordCount: 3,
      reason: 'close',
      createdAt: '2026-11-06T10:00:00.000Z'
    }
    commands.notesGetVersions.mockResolvedValue([version])
    commands.notesGetVersion.mockResolvedValueOnce({ ...version, fileContent: 'text\n' })
    await expect(notesService.getVersions('note-1')).resolves.toEqual([version])
    await expect(notesService.getVersion('v-1')).resolves.toEqual({
      ...version,
      fileContent: 'text\n'
    })
    commands.notesGetVersion.mockResolvedValueOnce(null)
    await expect(notesService.getVersion('gone')).resolves.toBeNull()

    const view = { id: 'note-1', path: 'Plan.md', created: CREATED, modified: MODIFIED }
    commands.notesRestoreVersion.mockResolvedValueOnce(view).mockResolvedValueOnce(null)
    await expect(notesService.restoreVersion('v-1')).resolves.toEqual({
      success: true,
      note: { ...view, created: new Date(CREATED), modified: new Date(MODIFIED) }
    })
    expect(commands.notesRestoreVersion).toHaveBeenCalledWith('v-1')
    // A journal day is no note.
    await expect(notesService.restoreVersion('v-2')).resolves.toEqual({ success: true, note: null })
    commands.notesRestoreVersion.mockRejectedValue({
      kind: 'Locked',
      code: 'note_locked',
      message: 'The owner made this note read-only.'
    })
    await expect(notesService.restoreVersion('v-1')).resolves.toEqual({
      success: false,
      error: 'The owner made this note read-only.',
      note: null
    })

    commands.notesDeleteVersion.mockResolvedValueOnce(null)
    await expect(notesService.deleteVersion('v-1')).resolves.toEqual({ success: true })
    expect(commands.notesDeleteVersion).toHaveBeenCalledWith('v-1')
    commands.notesDeleteVersion.mockRejectedValue({
      kind: 'Storage',
      code: 'failed',
      message: 'disk'
    })
    await expect(notesService.deleteVersion('v-1')).resolves.toEqual({
      success: false,
      error: 'disk'
    })
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

  it('names the title limit when a rename is refused for the length of the title (#4008)', async () => {
    commands.notesRename.mockRejectedValue({
      kind: 'invalid',
      code: 'invalid_title',
      message: 'the title is empty or longer than 200 characters'
    })
    const result = await notesService.rename('note-1', 'x'.repeat(201))
    expect(result).toEqual({
      success: false,
      error: getI18n().t('errors:note.invalidTitle'),
      note: null
    })
    expect(result.error).toContain('200')
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

  it('sends an upload as raw bytes and answers it in the envelope Electron gave', async () => {
    const saved = {
      path: '../attachments/note-1/abc123-note.txt',
      name: 'note.txt',
      size: 4,
      mimeType: 'text/plain',
      type: 'file'
    }
    invokeBinary.mockResolvedValueOnce(saved)
    // jsdom's File has no `arrayBuffer`. Without a `size`, the bytes read give it.
    const file = {
      name: 'note.txt',
      size: 4,
      arrayBuffer: async () => new TextEncoder().encode('data').buffer
    }
    await expect(notesService.uploadAttachment('note-1', file)).resolves.toEqual({
      success: true,
      ...saved
    })
    const [command, bytes, meta] = invokeBinary.mock.calls[0]
    expect(command).toBe('notes_upload_attachment')
    expect(new TextDecoder().decode(bytes)).toBe('data')
    expect(meta).toEqual({ noteId: 'note-1', fileName: 'note.txt', size: 4 })
  })

  it('never reads a file over the single-body limit and answers what Rust refused', async () => {
    const arrayBuffer = vi.fn()
    const big = { name: 'clip.mp4', size: 16 * 1024 * 1024 + 1, arrayBuffer }
    invokeBinary.mockRejectedValueOnce({
      kind: 'invalid',
      code: 'attachment_too_large',
      message: 'File too large: 16.0 MB exceeds 16.0 MB limit'
    })
    await expect(notesService.uploadAttachment('note-1', big)).resolves.toEqual({
      success: false,
      error: 'File too large: 16.0 MB exceeds 16.0 MB limit'
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
    const [, bytes, meta] = invokeBinary.mock.calls[0]
    expect(bytes).toHaveLength(0)
    expect(meta).toEqual({ noteId: 'note-1', fileName: 'clip.mp4', size: 16 * 1024 * 1024 + 1 })
  })

  it('answers a linked image download in the contract shape, a failure with its reason', async () => {
    commands.notesDownloadAttachmentFromUrl.mockResolvedValueOnce({
      status: 'saved',
      ref: '../attachments/note-1/x-photo.jpg'
    })
    await expect(
      notesService.downloadAttachmentFromUrl('note-1', 'https://x.test/photo.jpg')
    ).resolves.toEqual({ ok: true, ref: '../attachments/note-1/x-photo.jpg' })
    expect(commands.notesDownloadAttachmentFromUrl).toHaveBeenCalledWith(
      'note-1',
      'https://x.test/photo.jpg'
    )
    commands.notesDownloadAttachmentFromUrl.mockResolvedValueOnce({
      status: 'failed',
      reason: 'not-an-image'
    })
    await expect(
      notesService.downloadAttachmentFromUrl('note-1', 'https://x.test/page')
    ).resolves.toEqual({ ok: false, reason: 'not-an-image' })
  })

  describe('a file over the single-body limit', () => {
    const MIB = 1024 * 1024
    const saved = {
      path: '../attachments/note-1/abc123-clip.mp4',
      name: 'clip.mp4',
      size: 16 * MIB + 5,
      mimeType: 'video/mp4',
      type: 'file'
    }
    /** A `File` over the limit whose parts are read only through `slice`. */
    function bigFile(size = 16 * MIB + 5) {
      const arrayBuffer = vi.fn()
      const slice = vi.fn((start: number, end: number) => ({
        arrayBuffer: async () => new Uint8Array(Math.min(end, size) - start).fill(start / MIB)
      }))
      return { file: { name: 'clip.mp4', size, arrayBuffer, slice }, arrayBuffer, slice }
    }

    it('goes in 8 MiB parts, in order, and the last part answers the saved file', async () => {
      commands.notesUploadAttachmentBegin.mockResolvedValueOnce('up1')
      invokeBinary.mockResolvedValueOnce(null).mockResolvedValueOnce(null)
      invokeBinary.mockResolvedValueOnce(saved)
      const { file, arrayBuffer } = bigFile()
      await expect(notesService.uploadAttachment('note-1', file)).resolves.toEqual({
        success: true,
        ...saved
      })
      expect(commands.notesUploadAttachmentBegin).toHaveBeenCalledWith(
        'note-1',
        'clip.mp4',
        16 * MIB + 5
      )
      // Never the whole file in memory: one part per call.
      expect(arrayBuffer).not.toHaveBeenCalled()
      const sent = invokeBinary.mock.calls.map(([command, bytes, meta]) => [
        command,
        bytes.length,
        bytes[0],
        meta
      ])
      expect(sent).toEqual([
        ['notes_upload_attachment_chunk', 8 * MIB, 0, { id: 'up1', offset: 0 }],
        ['notes_upload_attachment_chunk', 8 * MIB, 8, { id: 'up1', offset: 8 * MIB }],
        ['notes_upload_attachment_chunk', 5, 16, { id: 'up1', offset: 16 * MIB }]
      ])
      expect(commands.notesUploadAttachmentAbort).not.toHaveBeenCalled()
    })

    it('a part that fails cancels the upload and answers why', async () => {
      commands.notesUploadAttachmentBegin.mockResolvedValueOnce('up2')
      commands.notesUploadAttachmentAbort.mockResolvedValueOnce(null)
      invokeBinary.mockResolvedValueOnce(null).mockRejectedValueOnce({
        kind: 'storage',
        code: 'attachment_write_failed',
        message: 'Failed to write attachment'
      })
      const { file } = bigFile()
      await expect(notesService.uploadAttachment('note-1', file)).resolves.toEqual({
        success: false,
        error: 'Failed to write attachment'
      })
      expect(invokeBinary).toHaveBeenCalledTimes(2)
      expect(commands.notesUploadAttachmentAbort).toHaveBeenCalledWith('up2')
    })

    it('a file that ends before Rust has every byte fails and cancels the upload', async () => {
      commands.notesUploadAttachmentBegin.mockResolvedValueOnce('up3')
      commands.notesUploadAttachmentAbort.mockResolvedValueOnce(null)
      invokeBinary.mockResolvedValue(null)
      const { file } = bigFile()
      await expect(notesService.uploadAttachment('note-1', file)).resolves.toEqual({
        success: false,
        error: getI18n().getFixedT(null, 'errors')('attachment.writeFailed')
      })
      expect(getI18n().getFixedT(null, 'errors')('attachment.writeFailed')).toBe(
        'Failed to save the attachment. Check disk space.'
      )
      expect(commands.notesUploadAttachmentAbort).toHaveBeenCalledWith('up3')
    })

    it('over the attachment cap, is refused before a part is read', async () => {
      commands.notesUploadAttachmentBegin.mockRejectedValueOnce({
        kind: 'invalid',
        code: 'attachment_too_large',
        message: 'File too large: 120.0 MB exceeds 100.0 MB limit'
      })
      const { file, slice } = bigFile(120 * MIB)
      await expect(notesService.uploadAttachment('note-1', file)).resolves.toEqual({
        success: false,
        error: 'File too large: 120.0 MB exceeds 100.0 MB limit'
      })
      expect(slice).not.toHaveBeenCalled()
      expect(invokeBinary).not.toHaveBeenCalled()
      expect(commands.notesUploadAttachmentAbort).not.toHaveBeenCalled()
    })
  })

  it('forwards the export helpers', async () => {
    api.notes.exportPdf = vi.fn().mockResolvedValue({ success: true })

    await notesService.exportPdf({ noteId: 'note-1', includeMetadata: true })
    expect(api.notes.exportPdf).toHaveBeenCalledWith({ noteId: 'note-1', includeMetadata: true })
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

  it('hands on a folder that sync changed or removed', async () => {
    const updated = vi.fn()
    const stop = onFolderConfigUpdated(updated)
    await vi.waitFor(() => expect(listeners.has('folderConfig')).toBe(true))
    listeners.get('folderConfig')?.({ payload: { path: 'Work/Plans' } })
    expect(updated).toHaveBeenCalledWith({ path: 'Work/Plans' })
    stop()
    await vi.waitFor(() => expect(listeners.has('folderConfig')).toBe(false))
  })

  it('registers the note event subscription not yet ported on window.api', () => {
    const unsubscribe = vi.fn()
    api.onNoteExternalChange = vi.fn(() => unsubscribe)
    const handler = vi.fn()

    expect(onNoteExternalChange(handler)).toBe(unsubscribe)
    expect(api.onNoteExternalChange).toHaveBeenCalledWith(handler)
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
