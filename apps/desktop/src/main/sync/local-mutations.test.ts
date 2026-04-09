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

vi.mock('./settings-sync', () => ({
  getSettingsSyncManager: vi.fn()
}))

vi.mock('./offline-clock', () => ({
  incrementTaskClocksOffline: vi.fn(),
  incrementProjectClocksOffline: vi.fn(),
  incrementInboxClockOffline: vi.fn(),
  incrementFilterClockOffline: vi.fn()
}))

import { getDatabase } from '../database'
import { incrementTaskClocksOffline } from './offline-clock'
import { getNoteSyncService } from './note-sync'
import { getSettingsSyncManager } from './settings-sync'
import { getTaskSyncService } from './task-sync'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncUpdate,
  removePendingNoteSyncItems,
  syncSettingsFieldUpdate
} from './local-mutations'

describe('local-mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
