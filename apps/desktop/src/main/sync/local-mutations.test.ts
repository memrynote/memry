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

vi.mock('./bookmark-sync', () => ({
  getBookmarkSyncService: vi.fn()
}))

vi.mock('./reminder-sync', () => ({
  getReminderSyncService: vi.fn()
}))

vi.mock('./template-sync', () => ({
  getTemplateSyncService: vi.fn()
}))

vi.mock('./home-page-sync', () => ({
  getHomePageSyncService: vi.fn()
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
  incrementFilterClockOffline: vi.fn(),
  incrementBookmarkClockOffline: vi.fn(),
  incrementReminderClockOffline: vi.fn(),
  incrementTemplateClockOffline: vi.fn(),
  incrementHomePageClockOffline: vi.fn(),
  incrementNoteClockOffline: vi.fn()
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
  incrementBookmarkClockOffline,
  incrementFilterClockOffline,
  incrementInboxClockOffline,
  incrementNoteClockOffline,
  incrementProjectClocksOffline,
  incrementReminderClockOffline,
  incrementTaskClocksOffline,
  incrementTemplateClockOffline,
  incrementHomePageClockOffline
} from './offline-clock'
import { getBookmarkSyncService } from './bookmark-sync'
import { getReminderSyncService } from './reminder-sync'
import { getTemplateSyncService } from './template-sync'
import { getHomePageSyncService } from './home-page-sync'
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
      getCalendarExternalEventSyncService,
      getBookmarkSyncService,
      getReminderSyncService,
      getTemplateSyncService,
      getHomePageSyncService
    ]) {
      ;(getter as Mock).mockReset().mockReturnValue(null)
    }
    ;(getDatabase as Mock).mockReturnValue('db')
  })

  // Bookmarks and reminders reach the queue only through this registry — a
  // mutation that writes the DB without routing here syncs nothing, with no
  // error to notice. Both directions are pinned: delegate when a service is
  // live, fall back to an offline clock bump when it is not.
  describe.each([
    {
      type: 'bookmark' as const,
      getService: getBookmarkSyncService,
      offlineBump: incrementBookmarkClockOffline,
      itemId: 'bm-1'
    },
    {
      type: 'reminder' as const,
      getService: getReminderSyncService,
      offlineBump: incrementReminderClockOffline,
      itemId: 'rem-1'
    },
    {
      type: 'template' as const,
      getService: getTemplateSyncService,
      offlineBump: incrementTemplateClockOffline,
      itemId: 'tpl-1'
    },
    {
      type: 'home_page' as const,
      getService: getHomePageSyncService,
      offlineBump: incrementHomePageClockOffline,
      itemId: 'board-1'
    }
  ])('$type local mutations', ({ type, getService, offlineBump, itemId }) => {
    it('routes creates to the live service', () => {
      const enqueueCreate = vi.fn()
      ;(getService as Mock).mockReturnValue({ enqueueCreate })

      enqueueLocalSyncCreate(type, itemId)

      expect(enqueueCreate).toHaveBeenCalledWith(itemId)
      expect(offlineBump).not.toHaveBeenCalled()
    })

    it('routes updates to the live service', () => {
      const enqueueUpdate = vi.fn()
      ;(getService as Mock).mockReturnValue({ enqueueUpdate })

      enqueueLocalSyncUpdate(type, itemId)

      expect(enqueueUpdate).toHaveBeenCalledWith(itemId)
      expect(offlineBump).not.toHaveBeenCalled()
    })

    it('falls back to an offline clock bump on create when no service is registered', () => {
      ;(getService as Mock).mockReturnValue(null)

      enqueueLocalSyncCreate(type, itemId)

      expect(offlineBump).toHaveBeenCalledWith('db', itemId)
    })

    it('falls back to an offline clock bump on update when no service is registered', () => {
      ;(getService as Mock).mockReturnValue(null)

      enqueueLocalSyncUpdate(type, itemId)

      expect(offlineBump).toHaveBeenCalledWith('db', itemId)
    })

    it('routes deletes to the live service with the snapshot payload', () => {
      const enqueueDelete = vi.fn()
      ;(getService as Mock).mockReturnValue({ enqueueDelete })

      enqueueLocalSyncDelete(type, itemId, '{"id":"snap"}')

      expect(enqueueDelete).toHaveBeenCalledWith(itemId, '{"id":"snap"}')
    })

    // enqueueDelete no-ops on a falsy snapshot: the delete payload cannot be
    // rebuilt after the row is gone, so a caller that forgets the snapshot
    // must not silently enqueue an unusable delete.
    it('drops a delete with no snapshot payload', () => {
      const enqueueDelete = vi.fn()
      ;(getService as Mock).mockReturnValue({ enqueueDelete })

      enqueueLocalSyncDelete(type, itemId)

      expect(enqueueDelete).not.toHaveBeenCalled()
    })
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

  it('falls back to the offline clock bump when the note sync service is down', () => {
    const db = {}
    ;(getDatabase as Mock).mockReturnValue(db)
    ;(getNoteSyncService as Mock).mockReturnValue(null)

    enqueueLocalSyncUpdate('note', 'note-1')

    // Without this the enqueue evaporated: a note update raised during runtime
    // teardown (an attachment upload finishing, say) was never pushed.
    expect(incrementNoteClockOffline).toHaveBeenCalledWith(db, 'note-1')
  })

  it('does not bump the offline clock when the note sync service is up', () => {
    const noteService = { enqueueUpdate: vi.fn() }
    ;(getNoteSyncService as Mock).mockReturnValue(noteService)

    enqueueLocalSyncUpdate('note', 'note-1')

    expect(noteService.enqueueUpdate).toHaveBeenCalledWith('note-1')
    expect(incrementNoteClockOffline).not.toHaveBeenCalled()
  })

  it('falls back to the offline clock bump when the journal sync service is down', () => {
    const db = {}
    ;(getDatabase as Mock).mockReturnValue(db)
    ;(getJournalSyncService as Mock).mockReturnValue(null)

    enqueueLocalSyncUpdate('journal', 'journal-1', '2026-08-04')

    // Journals had the same fallback-less adapter notes used to have, and are
    // additionally outside the note recovery sweep — so a metadata edit raised
    // during runtime teardown had nothing at all to re-push it.
    expect(incrementNoteClockOffline).toHaveBeenCalledWith(db, 'journal-1')
  })

  it('does not bump the offline clock when the journal sync service is up', () => {
    const journalService = { enqueueUpdate: vi.fn() }
    ;(getJournalSyncService as Mock).mockReturnValue(journalService)

    enqueueLocalSyncUpdate('journal', 'journal-1', '2026-08-04')

    expect(journalService.enqueueUpdate).toHaveBeenCalledWith('journal-1', '2026-08-04')
    expect(incrementNoteClockOffline).not.toHaveBeenCalled()
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
