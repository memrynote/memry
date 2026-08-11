import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BookmarksChannels,
  AccountChannels,
  FolderViewChannels,
  GraphChannels,
  InboxChannels,
  JournalChannels,
  ReminderChannels,
  SearchChannels,
  TagsChannels,
  VaultChannels
} from '@memry/contracts/ipc-channels'
import { UpdaterChannels } from '@memry/contracts/ipc-updater'
import { SYNC_CHANNELS, SYNC_EVENTS } from '@memry/contracts/ipc-sync'
import { AgentChannels } from '@memry/contracts/ipc-agent'
import { invoke, invokeSync, subscribe } from '../lib/ipc'
import { agentApi } from './agent'
import { bookmarksApi, bookmarkEvents } from './bookmarks'
import { propertiesApi, templatesApi, savedFiltersApi, contentEvents } from './content'
import { windowApi, getFileDropPaths, contextMenuApi, quickCaptureApi, flushApi } from './core'
import { folderViewApi, folderViewEvents } from './folder-view'
import { inboxEvents } from './inbox'
import { journalApi, journalEvents } from './journal'
import { remindersApi, reminderEvents } from './reminders'
import { graphApi, searchApi, searchEvents } from './search'
import { syncEvents } from './sync-events'
import { syncAuth, syncSetup, syncLinking, accountApi, syncDevices } from './sync-identity'
import { syncOps, cryptoApi, syncAttachments, syncCrdt } from './sync-ops'
import { tagsApi, tagEvents } from './tags'
import { updaterApi, updaterEvents } from './updater'
import { vaultApi, vaultEvents } from './vault'
import { applyStartupTheme, getStartupThemeSync, THEME_STORAGE_KEY } from '../lib/startup-theme'

const electronMock = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
    send: vi.fn(),
    sendSync: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn()
  },
  webUtils: {
    getPathForFile: vi.fn((file: File) => `/drop/${file.name}`)
  }
}))

vi.mock('electron', () => electronMock)

const callback = vi.fn()
const noPayload = Symbol('no payload')

async function expectInvoke(call: () => Promise<unknown>, channel: string, ...args: unknown[]) {
  electronMock.ipcRenderer.invoke.mockClear()
  await call()
  expect(electronMock.ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...args)
}

function expectSubscribe(
  call: () => () => void,
  channel: string,
  expectedPayload: unknown = { ok: true }
) {
  electronMock.ipcRenderer.on.mockClear()
  electronMock.ipcRenderer.removeListener.mockClear()

  const unsubscribe = call()
  const [[actualChannel, handler]] = electronMock.ipcRenderer.on.mock.calls

  expect(actualChannel).toBe(channel)
  handler({}, { ok: true })
  if (expectedPayload === noPayload) {
    expect(callback).toHaveBeenLastCalledWith()
  } else {
    expect(callback).toHaveBeenLastCalledWith(expectedPayload)
  }

  unsubscribe()
  expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith(channel, handler)
}

describe('preload api wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    electronMock.ipcRenderer.sendSync.mockReturnValue('dark')
  })

  it('routes core helpers through Electron IPC', async () => {
    await expectInvoke(() => invoke('custom:invoke', 1, 2), 'custom:invoke', 1, 2)

    expect(invokeSync('custom:sync')).toBe('dark')
    expect(electronMock.ipcRenderer.sendSync).toHaveBeenCalledWith('custom:sync')

    const unsubscribe = subscribe('custom:event', callback)
    const [[channel, handler]] = electronMock.ipcRenderer.on.mock.calls
    expect(channel).toBe('custom:event')
    handler({}, 'payload')
    expect(callback).toHaveBeenCalledWith('payload')
    unsubscribe()
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith('custom:event', handler)

    windowApi.windowMinimize()
    windowApi.windowMaximize()
    windowApi.windowClose()
    quickCaptureApi.close()
    quickCaptureApi.resize(240)
    quickCaptureApi.openSettings('sync')
    flushApi.notifyFlushDone('flush-1')

    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('window-minimize')
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('window-maximize')
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('window-close')
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('quick-capture:close')
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('quick-capture:resize', 240)
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith(
      'quick-capture:open-settings',
      'sync'
    )
    expect(electronMock.ipcRenderer.send).toHaveBeenCalledWith('app:flush-done', 'flush-1')

    expect(getFileDropPaths([new File(['x'], 'note.md')])).toEqual(['/drop/note.md'])
    expect(electronMock.webUtils.getPathForFile).toHaveBeenCalled()

    await expectInvoke(() => contextMenuApi([{ id: 'open', label: 'Open' }]), 'context-menu:show', [
      { id: 'open', label: 'Open' }
    ])
    await expectInvoke(() => quickCaptureApi.getClipboard(), 'quick-capture:get-clipboard')

    const flushCallback = vi.fn()
    const unsubscribeFlush = flushApi.onFlushRequested(flushCallback)
    const [, flushHandler] = electronMock.ipcRenderer.on.mock.calls.at(-1)!
    flushHandler({}, 'flush-2')
    expect(flushCallback).toHaveBeenCalledWith('flush-2')
    unsubscribeFlush()
  })

  it('fans out same-channel subscriptions through one Electron listener', () => {
    const first = vi.fn()
    const second = vi.fn()

    const unsubscribeFirst = subscribe('settings:changed', first)
    const unsubscribeSecond = subscribe('settings:changed', second)

    expect(electronMock.ipcRenderer.on).toHaveBeenCalledTimes(1)
    const [[channel, handler]] = electronMock.ipcRenderer.on.mock.calls
    expect(channel).toBe('settings:changed')

    handler({}, { key: 'general', value: { theme: 'dark' } })
    expect(first).toHaveBeenCalledWith({ key: 'general', value: { theme: 'dark' } })
    expect(second).toHaveBeenCalledWith({ key: 'general', value: { theme: 'dark' } })

    unsubscribeFirst()
    handler({}, { key: 'general', value: { theme: 'light' } })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenLastCalledWith({ key: 'general', value: { theme: 'light' } })
    expect(electronMock.ipcRenderer.removeListener).not.toHaveBeenCalled()

    unsubscribeSecond()
    expect(electronMock.ipcRenderer.removeListener).toHaveBeenCalledWith(
      'settings:changed',
      handler
    )
  })

  it('normalizes startup theme cache, sync fallback, and root classes', () => {
    const classList = {
      values: new Set<string>(),
      add: vi.fn((value: string) => classList.values.add(value)),
      remove: vi.fn((...values: string[]) =>
        values.forEach((value) => classList.values.delete(value))
      )
    }
    const storage = new Map<string, string>()
    const originalWindow = globalThis.window
    const originalDocument = globalThis.document

    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        localStorage: {
          getItem: vi.fn((key: string) => storage.get(key) ?? null)
        },
        matchMedia: vi.fn(() => ({ matches: true })),
        addEventListener: vi.fn()
      }
    })
    Object.defineProperty(globalThis, 'document', {
      configurable: true,
      value: {
        documentElement: {
          classList,
          style: {} as Record<string, string>
        }
      }
    })

    storage.set(THEME_STORAGE_KEY, 'white')
    expect(getStartupThemeSync()).toBe('white')

    storage.set(THEME_STORAGE_KEY, 'bad')
    electronMock.ipcRenderer.sendSync.mockReturnValue({ theme: 'light' })
    expect(getStartupThemeSync()).toBe('light')

    electronMock.ipcRenderer.sendSync.mockReturnValue('bad')
    expect(getStartupThemeSync()).toBe('system')

    applyStartupTheme('system')
    expect(classList.remove).toHaveBeenCalledWith('dark', 'white')
    expect(classList.add).toHaveBeenCalledWith('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')

    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument })
  })

  it('routes note-adjacent preload APIs through their IPC channels', async () => {
    await expectInvoke(() => propertiesApi.get('note-1'), 'properties:get', { entityId: 'note-1' })
    await expectInvoke(() => propertiesApi.set('note-1', { Status: 'Draft' }), 'properties:set', {
      entityId: 'note-1',
      properties: { Status: 'Draft' }
    })
    await expectInvoke(() => propertiesApi.rename('note-1', 'Old', 'New'), 'properties:rename', {
      entityId: 'note-1',
      oldName: 'Old',
      newName: 'New'
    })
    await expectInvoke(
      () => propertiesApi.resolveRefs(['memry://note/note-1']),
      'properties:resolveRefs',
      { uris: ['memry://note/note-1'] }
    )

    await expectInvoke(() => templatesApi.list(), 'templates:list')
    await expectInvoke(() => templatesApi.get('template-1'), 'templates:get', 'template-1')
    await expectInvoke(
      () => templatesApi.create({ name: 'Meeting', tags: ['work'] }),
      'templates:create',
      { name: 'Meeting', tags: ['work'] }
    )
    await expectInvoke(
      () => templatesApi.update({ id: 'template-1', name: 'Daily' }),
      'templates:update',
      { id: 'template-1', name: 'Daily' }
    )
    await expectInvoke(() => templatesApi.delete('template-1'), 'templates:delete', 'template-1')
    await expectInvoke(() => templatesApi.duplicate('template-1', 'Copy'), 'templates:duplicate', {
      id: 'template-1',
      newName: 'Copy'
    })

    await expectInvoke(() => savedFiltersApi.list(), 'saved-filters:list')
    await expectInvoke(
      () => savedFiltersApi.create({ name: 'Today', config: { due: 'today' } }),
      'saved-filters:create',
      { name: 'Today', config: { due: 'today' } }
    )
    await expectInvoke(
      () => savedFiltersApi.update({ id: 'filter-1', position: 2 }),
      'saved-filters:update',
      { id: 'filter-1', position: 2 }
    )
    await expectInvoke(() => savedFiltersApi.delete('filter-1'), 'saved-filters:delete', {
      id: 'filter-1'
    })
    await expectInvoke(() => savedFiltersApi.reorder(['a'], [1]), 'saved-filters:reorder', {
      ids: ['a'],
      positions: [1]
    })

    await expectInvoke(() => journalApi.getEntry('2026-05-10'), JournalChannels.invoke.GET_ENTRY, {
      date: '2026-05-10'
    })
    await expectInvoke(
      () => journalApi.createEntry({ date: '2026-05-10', content: 'Body' }),
      JournalChannels.invoke.CREATE_ENTRY,
      { date: '2026-05-10', content: 'Body' }
    )
    await expectInvoke(
      () => journalApi.updateEntry({ date: '2026-05-10', tags: ['x'] }),
      JournalChannels.invoke.UPDATE_ENTRY,
      { date: '2026-05-10', tags: ['x'] }
    )
    await expectInvoke(
      () => journalApi.deleteEntry('2026-05-10'),
      JournalChannels.invoke.DELETE_ENTRY,
      {
        date: '2026-05-10'
      }
    )
    await expectInvoke(() => journalApi.getHeatmap(2026), JournalChannels.invoke.GET_HEATMAP, {
      year: 2026
    })
    await expectInvoke(
      () => journalApi.getMonthEntries(2026, 5),
      JournalChannels.invoke.GET_MONTH_ENTRIES,
      { year: 2026, month: 5 }
    )
    await expectInvoke(() => journalApi.getYearStats(2026), JournalChannels.invoke.GET_YEAR_STATS, {
      year: 2026
    })
    await expectInvoke(
      () => journalApi.getDayContext('2026-05-10'),
      JournalChannels.invoke.GET_DAY_CONTEXT,
      {
        date: '2026-05-10'
      }
    )
    await expectInvoke(() => journalApi.getAllTags(), JournalChannels.invoke.GET_ALL_TAGS)
    await expectInvoke(() => journalApi.getStreak(), JournalChannels.invoke.GET_STREAK)
  })

  it('routes organizer APIs and event subscriptions', async () => {
    await expectInvoke(
      () => bookmarksApi.create({ itemType: 'note', itemId: 'note-1' }),
      BookmarksChannels.invoke.CREATE,
      { itemType: 'note', itemId: 'note-1' }
    )
    await expectInvoke(
      () => bookmarksApi.delete('bookmark-1'),
      BookmarksChannels.invoke.DELETE,
      'bookmark-1'
    )
    await expectInvoke(
      () => bookmarksApi.get('bookmark-1'),
      BookmarksChannels.invoke.GET,
      'bookmark-1'
    )
    await expectInvoke(() => bookmarksApi.list(), BookmarksChannels.invoke.LIST, {})
    await expectInvoke(
      () => bookmarksApi.list({ itemType: 'note', sortBy: 'position' }),
      BookmarksChannels.invoke.LIST,
      { itemType: 'note', sortBy: 'position' }
    )
    await expectInvoke(
      () => bookmarksApi.isBookmarked({ itemType: 'note', itemId: 'note-1' }),
      BookmarksChannels.invoke.IS_BOOKMARKED,
      { itemType: 'note', itemId: 'note-1' }
    )
    await expectInvoke(
      () => bookmarksApi.toggle({ itemType: 'note', itemId: 'note-1' }),
      BookmarksChannels.invoke.TOGGLE,
      { itemType: 'note', itemId: 'note-1' }
    )
    await expectInvoke(
      () => bookmarksApi.reorder(['bookmark-1']),
      BookmarksChannels.invoke.REORDER,
      { bookmarkIds: ['bookmark-1'] }
    )
    await expectInvoke(
      () => bookmarksApi.listByType('note'),
      BookmarksChannels.invoke.LIST_BY_TYPE,
      'note'
    )
    await expectInvoke(
      () => bookmarksApi.getByItem({ itemType: 'note', itemId: 'note-1' }),
      BookmarksChannels.invoke.GET_BY_ITEM,
      { itemType: 'note', itemId: 'note-1' }
    )
    await expectInvoke(
      () => bookmarksApi.bulkDelete(['bookmark-1']),
      BookmarksChannels.invoke.BULK_DELETE,
      { bookmarkIds: ['bookmark-1'] }
    )
    await expectInvoke(
      () => bookmarksApi.bulkCreate([{ itemType: 'note', itemId: 'note-1' }]),
      BookmarksChannels.invoke.BULK_CREATE,
      { items: [{ itemType: 'note', itemId: 'note-1' }] }
    )

    await expectInvoke(() => vaultApi.select('/vault'), VaultChannels.invoke.SELECT, {
      path: '/vault'
    })
    await expectInvoke(() => vaultApi.create('/vault', 'Main'), VaultChannels.invoke.SELECT, {
      path: '/vault'
    })
    await expectInvoke(() => vaultApi.getAll(), VaultChannels.invoke.GET_ALL)
    await expectInvoke(() => vaultApi.getStatus(), VaultChannels.invoke.GET_STATUS)
    await expectInvoke(() => vaultApi.getConfig(), VaultChannels.invoke.GET_CONFIG)
    await expectInvoke(
      () => vaultApi.updateConfig({ theme: 'dark' }),
      VaultChannels.invoke.UPDATE_CONFIG,
      {
        theme: 'dark'
      }
    )
    await expectInvoke(() => vaultApi.close(), VaultChannels.invoke.CLOSE)
    await expectInvoke(() => vaultApi.switch('/vault'), VaultChannels.invoke.SWITCH, '/vault')
    await expectInvoke(() => vaultApi.remove('/vault'), VaultChannels.invoke.REMOVE, '/vault')
    await expectInvoke(() => vaultApi.reindex(), VaultChannels.invoke.REINDEX)
    await expectInvoke(() => vaultApi.reveal(), VaultChannels.invoke.REVEAL)

    await expectInvoke(
      () => tagsApi.getNotesByTag({ tag: 'work' }),
      TagsChannels.invoke.GET_NOTES_BY_TAG,
      {
        tag: 'work'
      }
    )
    await expectInvoke(
      () => tagsApi.pinNoteToTag({ noteId: 'note-1', tag: 'work' }),
      TagsChannels.invoke.PIN_NOTE_TO_TAG,
      { noteId: 'note-1', tag: 'work' }
    )
    await expectInvoke(
      () => tagsApi.unpinNoteFromTag({ noteId: 'note-1', tag: 'work' }),
      TagsChannels.invoke.UNPIN_NOTE_FROM_TAG,
      { noteId: 'note-1', tag: 'work' }
    )
    await expectInvoke(
      () => tagsApi.renameTag({ oldName: 'old', newName: 'new' }),
      TagsChannels.invoke.RENAME_TAG,
      { oldName: 'old', newName: 'new' }
    )
    await expectInvoke(
      () => tagsApi.updateTagColor({ tag: 'work', color: 'blue' }),
      TagsChannels.invoke.UPDATE_TAG_COLOR,
      { tag: 'work', color: 'blue' }
    )
    await expectInvoke(() => tagsApi.deleteTag('work'), TagsChannels.invoke.DELETE_TAG, 'work')
    await expectInvoke(
      () => tagsApi.removeTagFromNote({ noteId: 'note-1', tag: 'work' }),
      TagsChannels.invoke.REMOVE_TAG_FROM_NOTE,
      { noteId: 'note-1', tag: 'work' }
    )
    await expectInvoke(() => tagsApi.getAllWithCounts(), TagsChannels.invoke.GET_ALL_WITH_COUNTS)
    await expectInvoke(
      () => tagsApi.mergeTag({ source: 'a', target: 'b' }),
      TagsChannels.invoke.MERGE_TAG,
      { source: 'a', target: 'b' }
    )

    expectSubscribe(
      () => bookmarkEvents.onBookmarkCreated(callback),
      BookmarksChannels.events.CREATED
    )
    expectSubscribe(
      () => bookmarkEvents.onBookmarkUpdated(callback),
      BookmarksChannels.events.UPDATED
    )
    expectSubscribe(
      () => bookmarkEvents.onBookmarkDeleted(callback),
      BookmarksChannels.events.DELETED
    )
    expectSubscribe(
      () => bookmarkEvents.onBookmarksReordered(callback),
      BookmarksChannels.events.REORDERED
    )
    expectSubscribe(
      () => vaultEvents.onVaultStatusChanged(callback),
      VaultChannels.events.STATUS_CHANGED
    )
    expectSubscribe(
      () => vaultEvents.onVaultIndexProgress(callback),
      VaultChannels.events.INDEX_PROGRESS
    )
    expectSubscribe(() => vaultEvents.onVaultError(callback), VaultChannels.events.ERROR)
    expectSubscribe(
      () => vaultEvents.onVaultIndexRecovered(callback),
      VaultChannels.events.INDEX_RECOVERED
    )
    expectSubscribe(() => tagEvents.onTagRenamed(callback), TagsChannels.events.RENAMED)
    expectSubscribe(() => tagEvents.onTagColorUpdated(callback), TagsChannels.events.COLOR_UPDATED)
    expectSubscribe(() => tagEvents.onTagDeleted(callback), TagsChannels.events.DELETED)
    expectSubscribe(() => tagEvents.onTagNotesChanged(callback), TagsChannels.events.NOTES_CHANGED)
  })

  it('routes folder, search, reminder, sync, and updater APIs', async () => {
    await expectInvoke(
      () => folderViewApi.getConfig('projects'),
      FolderViewChannels.invoke.GET_CONFIG,
      { folderPath: 'projects' }
    )
    await expectInvoke(
      () => folderViewApi.setConfig('projects', { layout: 'table' }),
      FolderViewChannels.invoke.SET_CONFIG,
      { folderPath: 'projects', config: { layout: 'table' } }
    )
    await expectInvoke(
      () => folderViewApi.getViews({ kind: 'folder', path: 'projects' }),
      FolderViewChannels.invoke.GET_VIEWS,
      { scope: { kind: 'folder', path: 'projects' } }
    )
    await expectInvoke(
      () => folderViewApi.setView({ kind: 'folder', path: 'projects' }, { name: 'Main' }),
      FolderViewChannels.invoke.SET_VIEW,
      { scope: { kind: 'folder', path: 'projects' }, view: { name: 'Main' } }
    )
    await expectInvoke(
      () => folderViewApi.deleteView({ kind: 'folder', path: 'projects' }, 'Main'),
      FolderViewChannels.invoke.DELETE_VIEW,
      { scope: { kind: 'folder', path: 'projects' }, viewName: 'Main' }
    )
    await expectInvoke(
      () =>
        folderViewApi.listWithProperties({
          scope: { kind: 'folder', path: 'projects' },
          limit: 10
        }),
      FolderViewChannels.invoke.LIST_WITH_PROPERTIES,
      { scope: { kind: 'folder', path: 'projects' }, limit: 10 }
    )
    await expectInvoke(
      () => folderViewApi.getAvailableProperties({ kind: 'folder', path: 'projects' }),
      FolderViewChannels.invoke.GET_AVAILABLE_PROPERTIES,
      { scope: { kind: 'folder', path: 'projects' } }
    )
    await expectInvoke(
      () => folderViewApi.getFolderSuggestions('note-1'),
      FolderViewChannels.invoke.GET_FOLDER_SUGGESTIONS,
      { noteId: 'note-1' }
    )
    await expectInvoke(
      () => folderViewApi.folderExists('projects'),
      FolderViewChannels.invoke.FOLDER_EXISTS,
      'projects'
    )

    await expectInvoke(() => graphApi.getData(), GraphChannels.invoke.GET_GRAPH_DATA)
    await expectInvoke(
      () => graphApi.getLocal({ noteId: 'note-1', depth: 2 }),
      GraphChannels.invoke.GET_LOCAL_GRAPH,
      {
        noteId: 'note-1',
        depth: 2
      }
    )
    await expectInvoke(() => searchApi.query({ text: 'memo' }), SearchChannels.invoke.QUERY, {
      text: 'memo'
    })
    await expectInvoke(() => searchApi.quick('memo'), SearchChannels.invoke.QUICK, {
      text: 'memo',
      noteFileTypes: undefined
    })
    await expectInvoke(() => searchApi.quick('memo', ['markdown']), SearchChannels.invoke.QUICK, {
      text: 'memo',
      noteFileTypes: ['markdown']
    })
    await expectInvoke(() => searchApi.getStats(), SearchChannels.invoke.GET_STATS)
    await expectInvoke(() => searchApi.rebuildIndex(), SearchChannels.invoke.REBUILD_INDEX)
    await expectInvoke(() => searchApi.getReasons(), SearchChannels.invoke.GET_REASONS)
    await expectInvoke(
      () =>
        searchApi.addReason({
          itemId: 'note-1',
          itemType: 'note',
          itemTitle: 'Note',
          searchQuery: 'memo'
        }),
      SearchChannels.invoke.ADD_REASON,
      { itemId: 'note-1', itemType: 'note', itemTitle: 'Note', searchQuery: 'memo' }
    )
    await expectInvoke(() => searchApi.clearReasons(), SearchChannels.invoke.CLEAR_REASONS)
    await expectInvoke(() => searchApi.getAllTags(), SearchChannels.invoke.GET_ALL_TAGS)

    await expectInvoke(
      () =>
        remindersApi.create({
          targetType: 'note',
          targetId: 'note-1',
          remindAt: '2026-05-10T10:00:00Z'
        }),
      ReminderChannels.invoke.CREATE,
      { targetType: 'note', targetId: 'note-1', remindAt: '2026-05-10T10:00:00Z' }
    )
    await expectInvoke(
      () => remindersApi.update({ id: 'reminder-1', title: 'Later' }),
      ReminderChannels.invoke.UPDATE,
      {
        id: 'reminder-1',
        title: 'Later'
      }
    )
    await expectInvoke(
      () => remindersApi.delete('reminder-1'),
      ReminderChannels.invoke.DELETE,
      'reminder-1'
    )
    await expectInvoke(
      () => remindersApi.get('reminder-1'),
      ReminderChannels.invoke.GET,
      'reminder-1'
    )
    await expectInvoke(() => remindersApi.list(), ReminderChannels.invoke.LIST, {})
    await expectInvoke(() => remindersApi.getUpcoming(7), ReminderChannels.invoke.GET_UPCOMING, 7)
    await expectInvoke(() => remindersApi.getDue(), ReminderChannels.invoke.GET_DUE)
    await expectInvoke(
      () => remindersApi.getForTarget({ targetType: 'note', targetId: 'note-1' }),
      ReminderChannels.invoke.GET_FOR_TARGET,
      { targetType: 'note', targetId: 'note-1' }
    )
    await expectInvoke(() => remindersApi.countPending(), ReminderChannels.invoke.COUNT_PENDING)
    await expectInvoke(
      () => remindersApi.dismiss('reminder-1'),
      ReminderChannels.invoke.DISMISS,
      'reminder-1'
    )
    await expectInvoke(
      () => remindersApi.snooze({ id: 'reminder-1', snoozeUntil: '2026-05-11T10:00:00Z' }),
      ReminderChannels.invoke.SNOOZE,
      { id: 'reminder-1', snoozeUntil: '2026-05-11T10:00:00Z' }
    )
    await expectInvoke(
      () => remindersApi.bulkDismiss({ reminderIds: ['reminder-1'] }),
      ReminderChannels.invoke.BULK_DISMISS,
      { reminderIds: ['reminder-1'] }
    )

    await expectInvoke(() => updaterApi.getState(), UpdaterChannels.invoke.GET_STATE)
    await expectInvoke(() => updaterApi.checkForUpdates(), UpdaterChannels.invoke.CHECK_FOR_UPDATES)
    await expectInvoke(() => updaterApi.downloadUpdate(), UpdaterChannels.invoke.DOWNLOAD_UPDATE)
    await expectInvoke(() => updaterApi.quitAndInstall(), UpdaterChannels.invoke.QUIT_AND_INSTALL)

    await expectInvoke(
      () => syncAuth.requestOtp({ email: 'k@example.com' }),
      SYNC_CHANNELS.AUTH_REQUEST_OTP,
      {
        email: 'k@example.com'
      }
    )
    await expectInvoke(
      () => syncAuth.verifyOtp({ email: 'k@example.com', code: '123456' }),
      SYNC_CHANNELS.AUTH_VERIFY_OTP,
      { email: 'k@example.com', code: '123456' }
    )
    await expectInvoke(
      () => syncAuth.resendOtp({ email: 'k@example.com' }),
      SYNC_CHANNELS.AUTH_RESEND_OTP,
      {
        email: 'k@example.com'
      }
    )
    await expectInvoke(
      () => syncAuth.initOAuth({ provider: 'google' }),
      SYNC_CHANNELS.AUTH_INIT_OAUTH,
      {
        provider: 'google'
      }
    )
    await expectInvoke(() => syncAuth.refreshToken(), SYNC_CHANNELS.AUTH_REFRESH_TOKEN)
    await expectInvoke(() => syncAuth.logout(), SYNC_CHANNELS.AUTH_LOGOUT)

    await expectInvoke(
      () => syncSetup.setupFirstDevice({ provider: 'google', oauthToken: 'token', state: 'state' }),
      SYNC_CHANNELS.SETUP_FIRST_DEVICE,
      { provider: 'google', oauthToken: 'token', state: 'state' }
    )
    await expectInvoke(() => syncSetup.setupNewAccount(), SYNC_CHANNELS.SETUP_NEW_ACCOUNT)
    await expectInvoke(
      () => syncSetup.confirmRecoveryPhrase({ confirmed: true }),
      SYNC_CHANNELS.CONFIRM_RECOVERY_PHRASE,
      { confirmed: true }
    )
    await expectInvoke(() => syncSetup.getRecoveryPhrase(), SYNC_CHANNELS.GET_RECOVERY_PHRASE)

    await expectInvoke(() => syncLinking.generateLinkingQr(), SYNC_CHANNELS.GENERATE_LINKING_QR)
    await expectInvoke(
      () => syncLinking.linkViaQr({ qrData: 'qr', provider: 'google', oauthToken: 'token' }),
      SYNC_CHANNELS.LINK_VIA_QR,
      { qrData: 'qr', provider: 'google', oauthToken: 'token' }
    )
    await expectInvoke(
      () => syncLinking.linkViaRecovery({ recoveryPhrase: 'phrase' }),
      SYNC_CHANNELS.LINK_VIA_RECOVERY,
      { recoveryPhrase: 'phrase' }
    )
    await expectInvoke(
      () => syncLinking.approveLinking({ sessionId: 's1' }),
      SYNC_CHANNELS.APPROVE_LINKING,
      {
        sessionId: 's1'
      }
    )
    await expectInvoke(
      () => syncLinking.getLinkingSas({ sessionId: 's1' }),
      SYNC_CHANNELS.GET_LINKING_SAS,
      {
        sessionId: 's1'
      }
    )
    await expectInvoke(
      () => syncLinking.completeLinkingQr({ sessionId: 's1' }),
      SYNC_CHANNELS.COMPLETE_LINKING_QR,
      { sessionId: 's1' }
    )

    await expectInvoke(() => accountApi.getInfo(), AccountChannels.invoke.GET_INFO)
    await expectInvoke(() => accountApi.signOut(), AccountChannels.invoke.SIGN_OUT)
    await expectInvoke(() => accountApi.startCheckout(), AccountChannels.invoke.START_CHECKOUT)
    await expectInvoke(
      () => accountApi.getBillingStatus(),
      AccountChannels.invoke.GET_BILLING_STATUS
    )
    await expectInvoke(
      () => accountApi.refreshBillingStatus({ transactionId: 'txn_1' }),
      AccountChannels.invoke.REFRESH_BILLING_STATUS,
      { transactionId: 'txn_1' }
    )
    await expectInvoke(
      () => accountApi.openBillingPortal(),
      AccountChannels.invoke.OPEN_BILLING_PORTAL
    )
    await expectInvoke(() => syncDevices.getDevices(), SYNC_CHANNELS.GET_DEVICES)
    await expectInvoke(
      () => syncDevices.removeDevice({ deviceId: 'd1' }),
      SYNC_CHANNELS.REMOVE_DEVICE,
      {
        deviceId: 'd1'
      }
    )
    await expectInvoke(
      () => syncDevices.renameDevice({ deviceId: 'd1', newName: 'Laptop' }),
      SYNC_CHANNELS.RENAME_DEVICE,
      { deviceId: 'd1', newName: 'Laptop' }
    )

    await expectInvoke(() => syncOps.getStatus(), SYNC_CHANNELS.GET_STATUS)
    await expectInvoke(() => syncOps.triggerSync(), SYNC_CHANNELS.TRIGGER_SYNC)
    await expectInvoke(() => syncOps.getHistory({ limit: 5 }), SYNC_CHANNELS.GET_HISTORY, {
      limit: 5
    })
    await expectInvoke(() => syncOps.getQueueSize(), SYNC_CHANNELS.GET_QUEUE_SIZE)
    await expectInvoke(() => syncOps.pause(), SYNC_CHANNELS.PAUSE)
    await expectInvoke(() => syncOps.resume(), SYNC_CHANNELS.RESUME)
    await expectInvoke(
      () => syncOps.updateSyncedSetting('editor.theme', 'dark'),
      SYNC_CHANNELS.UPDATE_SYNCED_SETTING,
      { fieldPath: 'editor.theme', value: 'dark' }
    )
    await expectInvoke(() => syncOps.getSyncedSettings(), SYNC_CHANNELS.GET_SYNCED_SETTINGS)
    await expectInvoke(() => syncOps.getStorageBreakdown(), SYNC_CHANNELS.GET_STORAGE_BREAKDOWN)

    const decryptInput = {
      itemId: 'item-1',
      type: 'note' as const,
      encryptedKey: 'key',
      keyNonce: 'key-nonce',
      encryptedData: 'data',
      dataNonce: 'data-nonce',
      signature: 'sig'
    }
    await expectInvoke(
      () => cryptoApi.encryptItem({ itemId: 'item-1', type: 'note', content: { title: 'Note' } }),
      SYNC_CHANNELS.ENCRYPT_ITEM,
      { itemId: 'item-1', type: 'note', content: { title: 'Note' } }
    )
    await expectInvoke(
      () => cryptoApi.decryptItem(decryptInput),
      SYNC_CHANNELS.DECRYPT_ITEM,
      decryptInput
    )
    await expectInvoke(
      () => cryptoApi.verifySignature(decryptInput),
      SYNC_CHANNELS.VERIFY_SIGNATURE,
      decryptInput
    )

    await expectInvoke(
      () => syncAttachments.upload({ noteId: 'note-1', filePath: '/tmp/file.pdf' }),
      SYNC_CHANNELS.UPLOAD_ATTACHMENT,
      { noteId: 'note-1', filePath: '/tmp/file.pdf' }
    )
    await expectInvoke(
      () => syncAttachments.getUploadProgress({ sessionId: 'upload-1' }),
      SYNC_CHANNELS.GET_UPLOAD_PROGRESS,
      { sessionId: 'upload-1' }
    )
    await expectInvoke(
      () => syncAttachments.download({ attachmentId: 'att-1', targetPath: '/tmp/file.pdf' }),
      SYNC_CHANNELS.DOWNLOAD_ATTACHMENT,
      { attachmentId: 'att-1', targetPath: '/tmp/file.pdf' }
    )
    await expectInvoke(
      () => syncAttachments.getDownloadProgress({ attachmentId: 'att-1' }),
      SYNC_CHANNELS.GET_DOWNLOAD_PROGRESS,
      { attachmentId: 'att-1' }
    )

    await expectInvoke(() => syncCrdt.openDoc({ noteId: 'note-1' }), SYNC_CHANNELS.OPEN_DOC, {
      noteId: 'note-1'
    })
    await expectInvoke(() => syncCrdt.closeDoc({ noteId: 'note-1' }), SYNC_CHANNELS.CLOSE_DOC, {
      noteId: 'note-1'
    })
    await expectInvoke(
      () => syncCrdt.applyUpdate({ noteId: 'note-1', update: [1] }),
      SYNC_CHANNELS.APPLY_UPDATE,
      { noteId: 'note-1', update: [1] }
    )
    await expectInvoke(
      () => syncCrdt.syncStep1({ noteId: 'note-1', stateVector: [1] }),
      SYNC_CHANNELS.SYNC_STEP_1,
      { noteId: 'note-1', stateVector: [1] }
    )
    await expectInvoke(
      () => syncCrdt.syncStep2({ noteId: 'note-1', diff: [1] }),
      SYNC_CHANNELS.SYNC_STEP_2,
      { noteId: 'note-1', diff: [1] }
    )
  })

  it('routes agent preload APIs through their IPC channels', async () => {
    await expectInvoke(
      () => agentApi.listConversations({ vaultId: 'vault-1' }),
      AgentChannels.invoke.LIST_CONVERSATIONS,
      { vaultId: 'vault-1' }
    )
    await expectInvoke(
      () =>
        agentApi.createConversation({
          vaultId: 'vault-1',
          backend: 'local_openai_compatible',
          backendModel: 'llama3'
        }),
      AgentChannels.invoke.CREATE_CONVERSATION,
      {
        vaultId: 'vault-1',
        backend: 'local_openai_compatible',
        backendModel: 'llama3'
      }
    )
    await expectInvoke(
      () => agentApi.loadConversation({ id: 'conversation-1' }),
      AgentChannels.invoke.LOAD_CONVERSATION,
      { id: 'conversation-1' }
    )
    await expectInvoke(
      () =>
        agentApi.sendTurn({
          conversationId: 'conversation-1',
          sourceWindowId: 'window-1',
          text: 'Create a task',
          attachments: [],
          backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
        }),
      AgentChannels.invoke.SEND_TURN,
      {
        conversationId: 'conversation-1',
        sourceWindowId: 'window-1',
        text: 'Create a task',
        attachments: [],
        backendOptions: { backend: 'codex_cli', reasoningEffort: 'medium' }
      }
    )
    await expectInvoke(
      () => agentApi.cancelTurn({ conversationId: 'conversation-1' }),
      AgentChannels.invoke.CANCEL_TURN,
      { conversationId: 'conversation-1' }
    )
    await expectInvoke(
      () =>
        agentApi.approveTool({
          conversationId: 'conversation-1',
          callId: 'call-1',
          approved: true
        }),
      AgentChannels.invoke.APPROVE_TOOL,
      { conversationId: 'conversation-1', callId: 'call-1', approved: true }
    )
    await expectInvoke(
      () =>
        agentApi.previewDiff({
          conversationId: 'conversation-1',
          callId: 'call-1'
        }),
      AgentChannels.invoke.PREVIEW_DIFF,
      { conversationId: 'conversation-1', callId: 'call-1' }
    )
    await expectInvoke(() => agentApi.getPreferences(), AgentChannels.invoke.GET_PREFERENCES)
    await expectInvoke(
      () => agentApi.setPreferences({ toolApprovalMode: 'ask' }),
      AgentChannels.invoke.SET_PREFERENCES,
      { toolApprovalMode: 'ask' }
    )
    await expectInvoke(
      () =>
        agentApi.editTrustList({
          conversationId: 'conversation-1',
          add: ['vault_create_task'],
          remove: ['vault_create_note']
        }),
      AgentChannels.invoke.EDIT_TRUST_LIST,
      {
        conversationId: 'conversation-1',
        add: ['vault_create_task'],
        remove: ['vault_create_note']
      }
    )
    await expectInvoke(
      () => agentApi.getBackendStatuses(),
      AgentChannels.invoke.GET_BACKEND_STATUSES
    )
    await expectInvoke(
      () => agentApi.listBackendModels({ backend: 'codex_cli' }),
      AgentChannels.invoke.LIST_BACKEND_MODELS,
      { backend: 'codex_cli' }
    )
    await expectInvoke(
      () => agentApi.getLocalProviderSettings(),
      AgentChannels.invoke.GET_LOCAL_PROVIDER_SETTINGS
    )
    await expectInvoke(
      () =>
        agentApi.setLocalProviderSettings({
          preset: 'ollama',
          baseUrl: 'http://localhost:11434/v1',
          model: 'llama3',
          apiKey: 'key'
        }),
      AgentChannels.invoke.SET_LOCAL_PROVIDER_SETTINGS,
      {
        preset: 'ollama',
        baseUrl: 'http://localhost:11434/v1',
        model: 'llama3',
        apiKey: 'key'
      }
    )
    await expectInvoke(() => agentApi.listLocalModels(), AgentChannels.invoke.LIST_LOCAL_MODELS)
    await expectInvoke(() => agentApi.testLocalProvider(), AgentChannels.invoke.TEST_LOCAL_PROVIDER)
    await expectInvoke(
      () => agentApi.probeLocalProvider(),
      AgentChannels.invoke.PROBE_LOCAL_PROVIDER
    )
    await expectInvoke(() => agentApi.acceptDisclosure(), AgentChannels.invoke.ACCEPT_DISCLOSURE)
    await expectInvoke(
      () => agentApi.getDisclosureState(),
      AgentChannels.invoke.GET_DISCLOSURE_STATE
    )
    await expectInvoke(() => agentApi.getWindowId(), AgentChannels.invoke.GET_WINDOW_ID)
    expectSubscribe(() => agentApi.onEvent(callback), AgentChannels.events.AGENT_EVENT)
  })

  it('routes preload event subscriptions', () => {
    expectSubscribe(() => contentEvents.onSavedFilterCreated(callback), 'saved-filters:created')
    expectSubscribe(() => contentEvents.onSavedFilterUpdated(callback), 'saved-filters:updated')
    expectSubscribe(() => contentEvents.onSavedFilterDeleted(callback), 'saved-filters:deleted')
    expectSubscribe(() => contentEvents.onTemplateCreated(callback), 'templates:created')
    expectSubscribe(() => contentEvents.onTemplateUpdated(callback), 'templates:updated')
    expectSubscribe(() => contentEvents.onTemplateDeleted(callback), 'templates:deleted')
    expectSubscribe(
      () => folderViewEvents.onFolderViewConfigUpdated(callback),
      FolderViewChannels.events.CONFIG_UPDATED
    )
    expectSubscribe(
      () => journalEvents.onJournalEntryCreated(callback),
      JournalChannels.events.ENTRY_CREATED
    )
    expectSubscribe(
      () => journalEvents.onJournalEntryUpdated(callback),
      JournalChannels.events.ENTRY_UPDATED
    )
    expectSubscribe(
      () => journalEvents.onJournalEntryDeleted(callback),
      JournalChannels.events.ENTRY_DELETED
    )
    expectSubscribe(
      () => journalEvents.onJournalExternalChange(callback),
      JournalChannels.events.EXTERNAL_CHANGE
    )
    expectSubscribe(
      () => reminderEvents.onReminderCreated(callback),
      ReminderChannels.events.CREATED
    )
    expectSubscribe(
      () => reminderEvents.onReminderUpdated(callback),
      ReminderChannels.events.UPDATED
    )
    expectSubscribe(
      () => reminderEvents.onReminderDeleted(callback),
      ReminderChannels.events.DELETED
    )
    expectSubscribe(() => reminderEvents.onReminderDue(callback), ReminderChannels.events.DUE)
    expectSubscribe(
      () => reminderEvents.onReminderDismissed(callback),
      ReminderChannels.events.DISMISSED
    )
    expectSubscribe(
      () => reminderEvents.onReminderSnoozed(callback),
      ReminderChannels.events.SNOOZED
    )
    expectSubscribe(
      () => reminderEvents.onReminderClicked(callback),
      ReminderChannels.events.CLICKED
    )
    expectSubscribe(() => inboxEvents.onInboxReviewDue(callback), InboxChannels.events.REVIEW_DUE)
    expectSubscribe(
      () => inboxEvents.onInboxReviewOpen(callback),
      InboxChannels.events.REVIEW_OPEN,
      noPayload
    )
    expectSubscribe(
      () => searchEvents.onSearchIndexRebuildStarted(callback),
      SearchChannels.events.INDEX_REBUILD_STARTED,
      noPayload
    )
    expect(callback).toHaveBeenLastCalledWith()
    expectSubscribe(
      () => searchEvents.onSearchIndexRebuildProgress(callback),
      SearchChannels.events.INDEX_REBUILD_PROGRESS
    )
    expectSubscribe(
      () => searchEvents.onSearchIndexRebuildCompleted(callback),
      SearchChannels.events.INDEX_REBUILD_COMPLETED,
      noPayload
    )
    expect(callback).toHaveBeenLastCalledWith()
    expectSubscribe(
      () => searchEvents.onSearchIndexCorrupt(callback),
      SearchChannels.events.INDEX_CORRUPT,
      noPayload
    )
    expect(callback).toHaveBeenLastCalledWith()
    expectSubscribe(() => syncEvents.onSyncStatusChanged(callback), SYNC_EVENTS.STATUS_CHANGED)
    expectSubscribe(() => syncEvents.onItemSynced(callback), SYNC_EVENTS.ITEM_SYNCED)
    expectSubscribe(() => syncEvents.onConflictDetected(callback), SYNC_EVENTS.CONFLICT_DETECTED)
    expectSubscribe(() => syncEvents.onLinkingRequest(callback), SYNC_EVENTS.LINKING_REQUEST)
    expectSubscribe(() => syncEvents.onLinkingApproved(callback), SYNC_EVENTS.LINKING_APPROVED)
    expectSubscribe(() => syncEvents.onLinkingFinalized(callback), SYNC_EVENTS.LINKING_FINALIZED)
    expectSubscribe(() => syncEvents.onUploadProgress(callback), SYNC_EVENTS.UPLOAD_PROGRESS)
    expectSubscribe(() => syncEvents.onDownloadProgress(callback), SYNC_EVENTS.DOWNLOAD_PROGRESS)
    expectSubscribe(
      () => syncEvents.onInitialSyncProgress(callback),
      SYNC_EVENTS.INITIAL_SYNC_PROGRESS
    )
    expectSubscribe(() => syncEvents.onQueueCleared(callback), SYNC_EVENTS.QUEUE_CLEARED)
    expectSubscribe(() => syncEvents.onSyncPaused(callback), SYNC_EVENTS.PAUSED)
    expectSubscribe(() => syncEvents.onSyncResumed(callback), SYNC_EVENTS.RESUMED)
    expectSubscribe(() => syncEvents.onSessionExpired(callback), SYNC_EVENTS.SESSION_EXPIRED)
    expectSubscribe(() => syncEvents.onDeviceRevoked(callback), SYNC_EVENTS.DEVICE_REMOVED)
    expectSubscribe(() => syncEvents.onOtpDetected(callback), SYNC_EVENTS.OTP_DETECTED)
    expectSubscribe(() => syncEvents.onOAuthCallback(callback), SYNC_EVENTS.OAUTH_CALLBACK)
    expectSubscribe(() => syncEvents.onOAuthError(callback), SYNC_EVENTS.OAUTH_ERROR)
    expectSubscribe(() => syncEvents.onClockSkewWarning(callback), SYNC_EVENTS.CLOCK_SKEW_WARNING)
    expectSubscribe(() => syncEvents.onSecurityWarning(callback), SYNC_EVENTS.SECURITY_WARNING)
    expectSubscribe(
      () => syncEvents.onCertificatePinFailed(callback),
      SYNC_EVENTS.CERTIFICATE_PIN_FAILED
    )
    expectSubscribe(
      () => syncEvents.onVaultRecoveryNeeded(callback),
      SYNC_EVENTS.VAULT_RECOVERY_NEEDED
    )
    // `onCrdtStateChanged` is note-scoped rather than a plain channel wrapper —
    // its routing and listener lifetime are covered in `sync-ops.test.ts`.
    expectSubscribe(
      () => updaterEvents.onUpdaterStateChanged(callback),
      UpdaterChannels.events.STATE_CHANGED
    )
  })
})
