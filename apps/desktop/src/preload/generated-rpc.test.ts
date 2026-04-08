import { describe, expect, it, vi } from 'vitest'
import {
  InboxChannels,
  NotesChannels,
  SettingsChannels,
  TasksChannels
} from '@memry/contracts/ipc-channels'
import { createGeneratedRpcApi } from './generated-rpc'

describe('createGeneratedRpcApi', () => {
  it('routes generated invoke clients through the provided invoke helpers', async () => {
    const invoke = vi.fn(async () => ({ success: true }))
    const invokeSync = vi.fn(() => ({ theme: 'dark' }))
    const subscribe = vi.fn()

    const api = createGeneratedRpcApi({
      invoke,
      invokeSync,
      subscribe
    })

    await api.tasks.create({ projectId: 'project-1', title: 'Task' })
    expect(invoke).toHaveBeenCalledWith(TasksChannels.invoke.CREATE, {
      projectId: 'project-1',
      title: 'Task'
    })

    await api.notes.rename('note-1', 'Renamed')
    expect(invoke).toHaveBeenCalledWith(NotesChannels.invoke.RENAME, {
      id: 'note-1',
      newTitle: 'Renamed'
    })

    await api.inbox.linkToNote('item-1', 'note-1', ['tag-a'])
    expect(invoke).toHaveBeenCalledWith(InboxChannels.invoke.LINK_TO_NOTE, 'item-1', 'note-1', [
      'tag-a'
    ])

    await api.inbox.trackSuggestion({
      itemId: 'item-1',
      itemType: 'link',
      suggestedTo: 'projects',
      actualTo: 'inbox',
      confidence: 0.7
    })
    expect(invoke).toHaveBeenCalledWith(
      InboxChannels.invoke.TRACK_SUGGESTION,
      'item-1',
      'link',
      'projects',
      'inbox',
      0.7,
      [],
      []
    )

    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    await api.notes.uploadAttachment('note-1', file)
    expect(invoke).toHaveBeenCalledWith(NotesChannels.invoke.UPLOAD_ATTACHMENT, {
      noteId: 'note-1',
      filename: 'note.txt',
      data: Array.from(new TextEncoder().encode('hello'))
    })

    await api.notes.deleteAttachment('note-1', 'note.txt')
    expect(invoke).toHaveBeenCalledWith(NotesChannels.invoke.DELETE_ATTACHMENT, {
      noteId: 'note-1',
      filename: 'note.txt'
    })

    await api.notes.getPositions('projects')
    expect(invoke).toHaveBeenCalledWith(NotesChannels.invoke.GET_POSITIONS, {
      folderPath: 'projects'
    })

    await api.notes.importFiles(['/tmp/a.md'], 'projects')
    expect(invoke).toHaveBeenCalledWith(NotesChannels.invoke.IMPORT_FILES, {
      sourcePaths: ['/tmp/a.md'],
      targetFolder: 'projects'
    })

    await api.settings.setTaskSettings({ staleInboxDays: 14 })
    expect(invoke).toHaveBeenCalledWith(SettingsChannels.invoke.SET_TASK_SETTINGS, {
      staleInboxDays: 14
    })

    expect(api.settings.getStartupThemeSync()).toBe('dark')
    expect(invokeSync).toHaveBeenCalledWith(SettingsChannels.sync.GET_STARTUP_THEME)
  })

  it('routes generated event subscriptions through the provided subscribe helper', () => {
    const unsubscribe = vi.fn()
    const invoke = vi.fn()
    const invokeSync = vi.fn(() => 'system')
    const subscribe = vi.fn(() => unsubscribe)
    const noteCreated = vi.fn()
    const taskUpdated = vi.fn()
    const inboxCaptured = vi.fn()
    const settingsChanged = vi.fn()

    const api = createGeneratedRpcApi({
      invoke,
      invokeSync,
      subscribe
    })

    expect(api.onNoteCreated(noteCreated)).toBe(unsubscribe)
    expect(api.onTaskUpdated(taskUpdated)).toBe(unsubscribe)
    expect(api.onInboxCaptured(inboxCaptured)).toBe(unsubscribe)
    expect(api.onSettingsChanged(settingsChanged)).toBe(unsubscribe)

    expect(subscribe).toHaveBeenNthCalledWith(1, NotesChannels.events.CREATED, noteCreated)
    expect(subscribe).toHaveBeenNthCalledWith(2, TasksChannels.events.UPDATED, taskUpdated)
    expect(subscribe).toHaveBeenNthCalledWith(3, InboxChannels.events.CAPTURED, inboxCaptured)
    expect(subscribe).toHaveBeenNthCalledWith(4, SettingsChannels.events.CHANGED, settingsChanged)
  })
})
