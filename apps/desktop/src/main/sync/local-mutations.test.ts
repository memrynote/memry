import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('../database', () => ({
  getDatabase: vi.fn()
}))

vi.mock('./task-sync', () => ({
  getTaskSyncService: vi.fn()
}))

vi.mock('./project-sync', () => ({
  getProjectSyncService: vi.fn()
}))

vi.mock('./inbox-sync', () => ({
  getInboxSyncService: vi.fn()
}))

vi.mock('./filter-sync', () => ({
  getFilterSyncService: vi.fn()
}))

vi.mock('./note-sync', () => ({
  getNoteSyncService: vi.fn()
}))

vi.mock('./journal-sync', () => ({
  getJournalSyncService: vi.fn()
}))

vi.mock('./tag-definition-sync', () => ({
  getTagDefinitionSyncService: vi.fn()
}))

vi.mock('./tag-category-sync', () => ({
  getTagCategorySyncService: vi.fn()
}))

vi.mock('./settings-sync', () => ({
  getSettingsSyncManager: vi.fn()
}))

vi.mock('./folder-config-sync', () => ({
  getFolderConfigSyncService: vi.fn()
}))

vi.mock('./calendar-event-sync', () => ({
  getCalendarEventSyncService: vi.fn()
}))

vi.mock('./calendar-source-sync', () => ({
  getCalendarSourceSyncService: vi.fn()
}))

vi.mock('./calendar-binding-sync', () => ({
  getCalendarBindingSyncService: vi.fn()
}))

vi.mock('./calendar-external-event-sync', () => ({
  getCalendarExternalEventSyncService: vi.fn()
}))

vi.mock('./offline-clock', () => ({
  incrementTaskClocksOffline: vi.fn(),
  incrementProjectClocksOffline: vi.fn(),
  incrementInboxClockOffline: vi.fn(),
  incrementFilterClockOffline: vi.fn()
}))

import { getDatabase } from '../database'
import { getCalendarBindingSyncService } from './calendar-binding-sync'
import { getCalendarEventSyncService } from './calendar-event-sync'
import { getCalendarExternalEventSyncService } from './calendar-external-event-sync'
import { getCalendarSourceSyncService } from './calendar-source-sync'
import { getFilterSyncService } from './filter-sync'
import { getFolderConfigSyncService } from './folder-config-sync'
import { getInboxSyncService } from './inbox-sync'
import {
  incrementFilterClockOffline,
  incrementInboxClockOffline,
  incrementProjectClocksOffline,
  incrementTaskClocksOffline
} from './offline-clock'
import { getProjectSyncService } from './project-sync'
import { getNoteSyncService } from './note-sync'
import { getSettingsSyncManager } from './settings-sync'
import { getJournalSyncService } from './journal-sync'
import { getTagDefinitionSyncService } from './tag-definition-sync'
import { getTagCategorySyncService } from './tag-category-sync'
import { getTaskSyncService } from './task-sync'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate,
  removePendingNoteSyncItems,
  syncSettingsFieldUpdate
} from './local-mutations'

describe('local-mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const getter of [
      getTaskSyncService,
      getProjectSyncService,
      getInboxSyncService,
      getFilterSyncService,
      getNoteSyncService,
      getJournalSyncService,
      getTagDefinitionSyncService,
      getTagCategorySyncService,
      getSettingsSyncManager,
      getFolderConfigSyncService,
      getCalendarEventSyncService,
      getCalendarSourceSyncService,
      getCalendarBindingSyncService,
      getCalendarExternalEventSyncService
    ]) {
      ;(getter as Mock).mockReset().mockReturnValue(null)
    }
    ;(getDatabase as Mock).mockReturnValue('db')
  })

  it('routes task creates through the local sync adapter registry', () => {
    const enqueueCreate = vi.fn()
    ;(getTaskSyncService as Mock).mockReturnValue({ enqueueCreate })

    enqueueLocalSyncCreate('task', 'task-1')

    expect(enqueueCreate).toHaveBeenCalledWith('task-1')
    expect(incrementTaskClocksOffline).not.toHaveBeenCalled()
  })

  it('keeps offline task clock fallback behind local sync adapters', () => {
    ;(getTaskSyncService as Mock).mockReturnValue(null)

    enqueueLocalSyncUpdate('task', 'task-1', ['position'])

    expect(incrementTaskClocksOffline).toHaveBeenCalledWith('db', 'task-1', ['position'])
  })

  it('falls back to offline clocks for project, inbox, and filter mutations without services', () => {
    ;(getProjectSyncService as Mock).mockReturnValue(null)
    ;(getInboxSyncService as Mock).mockReturnValue(null)
    ;(getFilterSyncService as Mock).mockReturnValue(null)

    enqueueLocalSyncCreate('project', 'project-1')
    enqueueLocalSyncUpdate('project', 'project-1', ['name'])
    enqueueLocalSyncCreate('inbox', 'inbox-1')
    enqueueLocalSyncUpdate('filter', 'filter-1')

    expect(incrementProjectClocksOffline).toHaveBeenNthCalledWith(1, 'db', 'project-1')
    expect(incrementProjectClocksOffline).toHaveBeenNthCalledWith(2, 'db', 'project-1', ['name'])
    expect(incrementInboxClockOffline).toHaveBeenCalledWith('db', 'inbox-1')
    expect(incrementFilterClockOffline).toHaveBeenCalledWith('db', 'filter-1')
  })

  it('routes record adapter creates, updates, and snapshot deletes through initialized services', () => {
    const services = [
      ['project', getProjectSyncService],
      ['inbox', getInboxSyncService],
      ['filter', getFilterSyncService],
      ['tag_definition', getTagDefinitionSyncService],
      ['tag_category', getTagCategorySyncService],
      ['folder_config', getFolderConfigSyncService],
      ['calendar_source', getCalendarSourceSyncService],
      ['calendar_binding', getCalendarBindingSyncService],
      ['calendar_external_event', getCalendarExternalEventSyncService]
    ] as const

    for (const [type, getter] of services) {
      const service = {
        enqueueCreate: vi.fn(),
        enqueueUpdate: vi.fn(),
        enqueueDelete: vi.fn()
      }
      ;(getter as Mock).mockReturnValue(service)

      enqueueLocalSyncCreate(type, `${type}-1`)
      enqueueLocalSyncUpdate(type, `${type}-1`, ['field'])
      enqueueLocalSyncDelete(type, `${type}-1`, 'snapshot')

      expect(service.enqueueCreate).toHaveBeenCalledWith(`${type}-1`)
      expect(service.enqueueUpdate).toHaveBeenCalledWith(
        `${type}-1`,
        ...(type === 'project' ? [['field']] : [])
      )
      expect(service.enqueueDelete).toHaveBeenCalledWith(`${type}-1`, 'snapshot')
    }
  })

  it('routes note, journal, settings, and calendar-event adapter edge cases', () => {
    const noteService = { enqueueCreate: vi.fn(), enqueueUpdate: vi.fn(), enqueueDelete: vi.fn() }
    const journalService = {
      enqueueCreate: vi.fn(),
      enqueueUpdate: vi.fn(),
      enqueueDelete: vi.fn()
    }
    const calendarEventService = {
      enqueueCreate: vi.fn(),
      enqueueUpdate: vi.fn(),
      enqueueDelete: vi.fn()
    }
    const settingsService = {
      enqueueCreate: vi.fn(),
      enqueueUpdate: vi.fn(),
      enqueueDelete: vi.fn()
    }

    ;(getNoteSyncService as Mock).mockReturnValue(noteService)
    ;(getJournalSyncService as Mock).mockReturnValue(journalService)
    ;(getCalendarEventSyncService as Mock).mockReturnValue(calendarEventService)
    ;(getSettingsSyncManager as Mock).mockReturnValue(settingsService)

    enqueueLocalSyncCreate('note', 'note-1')
    enqueueLocalSyncUpdate('note', 'note-1')
    enqueueLocalSyncDelete('note', 'note-1')
    enqueueLocalSyncCreate('journal', 'journal-1')
    enqueueLocalSyncUpdate('journal', 'journal-1', '2026-05-10')
    enqueueLocalSyncDelete('journal', 'journal-1', '2026-05-10')
    enqueueLocalSyncCreate('settings', 'settings')
    enqueueLocalSyncUpdate('settings', 'settings')
    enqueueLocalSyncDelete('settings', 'settings')
    enqueueLocalSyncUpdate('calendar_event', 'event-1', ['title'])

    expect(noteService.enqueueCreate).toHaveBeenCalledWith('note-1')
    expect(noteService.enqueueUpdate).toHaveBeenCalledWith('note-1')
    expect(noteService.enqueueDelete).toHaveBeenCalledWith('note-1')
    expect(journalService.enqueueCreate).not.toHaveBeenCalled()
    expect(journalService.enqueueUpdate).toHaveBeenCalledWith('journal-1', '2026-05-10')
    expect(journalService.enqueueDelete).toHaveBeenCalledWith('journal-1', '2026-05-10')
    expect(settingsService.enqueueCreate).toHaveBeenCalled()
    expect(settingsService.enqueueUpdate).toHaveBeenCalled()
    expect(settingsService.enqueueDelete).toHaveBeenCalled()
    expect(calendarEventService.enqueueUpdate).toHaveBeenCalledWith('event-1', ['title'])
  })

  it('skips snapshot-dependent deletes and missing settings/note helpers', () => {
    const taskService = { enqueueDelete: vi.fn() }
    const projectService = { enqueueDelete: vi.fn() }
    const inboxService = { enqueueDelete: vi.fn() }
    const filterService = { enqueueDelete: vi.fn() }

    ;(getTaskSyncService as Mock).mockReturnValue(taskService)
    ;(getProjectSyncService as Mock).mockReturnValue(projectService)
    ;(getInboxSyncService as Mock).mockReturnValue(inboxService)
    ;(getFilterSyncService as Mock).mockReturnValue(filterService)
    ;(getNoteSyncService as Mock).mockReturnValue(null)
    ;(getSettingsSyncManager as Mock).mockReturnValue(null)

    enqueueLocalSyncDelete('task', 'task-1')
    enqueueLocalSyncDelete('project', 'project-1')
    enqueueLocalSyncDelete('inbox', 'inbox-1')
    enqueueLocalSyncDelete('filter', 'filter-1')

    expect(taskService.enqueueDelete).not.toHaveBeenCalled()
    expect(projectService.enqueueDelete).not.toHaveBeenCalled()
    expect(inboxService.enqueueDelete).not.toHaveBeenCalled()
    expect(filterService.enqueueDelete).not.toHaveBeenCalled()
    expect(removePendingNoteSyncItems('note-1')).toBe(0)
    expect(() => syncSettingsFieldUpdate('general.locale', 'tr')).not.toThrow()
  })

  it('removes pending note sync items through the local sync helper', () => {
    const removeQueueItems = vi.fn(() => 2)
    ;(getNoteSyncService as Mock).mockReturnValue({ removeQueueItems })

    expect(removePendingNoteSyncItems('note-1')).toBe(2)
    expect(removeQueueItems).toHaveBeenCalledWith('note-1')
  })

  it('routes synced settings field updates through the sync helper', () => {
    const updateField = vi.fn()
    ;(getSettingsSyncManager as Mock).mockReturnValue({ updateField })

    syncSettingsFieldUpdate('general.sidebarWidth', 320)

    expect(updateField).toHaveBeenCalledWith('general.sidebarWidth', 320, 'local')
  })
})
