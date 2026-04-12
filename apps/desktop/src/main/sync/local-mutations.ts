import type { SyncItemType } from '@memry/contracts/sync-api'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import {
  incrementFilterClockOffline,
  incrementInboxClockOffline,
  incrementProjectClocksOffline,
  incrementTaskClocksOffline
} from './offline-clock'
import { getFilterSyncService } from './filter-sync'
import { getInboxSyncService } from './inbox-sync'
import { getJournalSyncService } from './journal-sync'
import { getNoteSyncService } from './note-sync'
import { getProjectSyncService } from './project-sync'
import { getSettingsSyncManager } from './settings-sync'
import { getTagDefinitionSyncService } from './tag-definition-sync'
import { getTaskSyncService } from './task-sync'
import { getFolderConfigSyncService } from './folder-config-sync'
import { getCalendarEventSyncService } from './calendar-event-sync'
import { getCalendarSourceSyncService } from './calendar-source-sync'
import { getCalendarBindingSyncService } from './calendar-binding-sync'
import { getCalendarExternalEventSyncService } from './calendar-external-event-sync'

const log = createLogger('LocalSync')

type LocalSyncType = Exclude<SyncItemType, 'attachment'>

const localSyncRegistry = createSyncAdapterRegistry([
  {
    type: 'task',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getTaskSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementTaskClocksOffline(getDatabase(), itemId, [])
      },
      enqueueUpdate(itemId: string, changedFields?: string[]): void {
        const service = getTaskSyncService()
        if (service) {
          service.enqueueUpdate(itemId, changedFields)
          return
        }

        incrementTaskClocksOffline(getDatabase(), itemId, changedFields ?? [])
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getTaskSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'project',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getProjectSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementProjectClocksOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string, changedFields?: string[]): void {
        const service = getProjectSyncService()
        if (service) {
          service.enqueueUpdate(itemId, changedFields)
          return
        }

        incrementProjectClocksOffline(getDatabase(), itemId, changedFields)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getProjectSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'inbox',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getInboxSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementInboxClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getInboxSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementInboxClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getInboxSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'filter',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getFilterSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementFilterClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getFilterSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementFilterClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        getFilterSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'note',
    kind: 'crdt',
    local: {
      enqueueCreate(itemId: string): void {
        getNoteSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getNoteSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string): void {
        getNoteSyncService()?.enqueueDelete(itemId)
      }
    }
  },
  {
    type: 'journal',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string, date?: string): void {
        if (!date) return
        getJournalSyncService()?.enqueueCreate(itemId, date)
      },
      enqueueUpdate(itemId: string, date?: string): void {
        if (!date) return
        getJournalSyncService()?.enqueueUpdate(itemId, date)
      },
      enqueueDelete(itemId: string, date?: string): void {
        if (!date) return
        getJournalSyncService()?.enqueueDelete(itemId, date)
      }
    }
  },
  {
    type: 'tag_definition',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getTagDefinitionSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getTagDefinitionSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getTagDefinitionSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'settings',
    kind: 'record',
    local: {
      enqueueCreate(): void {
        getSettingsSyncManager()?.enqueueCreate()
      },
      enqueueUpdate(): void {
        getSettingsSyncManager()?.enqueueUpdate()
      },
      enqueueDelete(): void {
        getSettingsSyncManager()?.enqueueDelete()
      }
    }
  },
  {
    type: 'folder_config',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getFolderConfigSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getFolderConfigSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getFolderConfigSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'calendar_event',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getCalendarEventSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getCalendarEventSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getCalendarEventSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'calendar_source',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getCalendarSourceSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getCalendarSourceSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getCalendarSourceSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'calendar_binding',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getCalendarBindingSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getCalendarBindingSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getCalendarBindingSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'calendar_external_event',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        getCalendarExternalEventSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        getCalendarExternalEventSyncService()?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        getCalendarExternalEventSyncService()?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  }
])

function callLocalMutation(
  type: LocalSyncType,
  method: 'enqueueCreate' | 'enqueueUpdate' | 'enqueueDelete',
  itemId: string,
  extra: unknown[]
): void {
  const adapter = localSyncRegistry.getLocal(type)
  if (!adapter) {
    log.warn('Missing local sync adapter', { type, method, itemId })
    return
  }

  adapter[method](itemId, ...extra)
}

export function enqueueLocalSyncCreate(
  type: LocalSyncType,
  itemId: string,
  ...extra: unknown[]
): void {
  callLocalMutation(type, 'enqueueCreate', itemId, extra)
}

export function enqueueLocalSyncUpdate(
  type: LocalSyncType,
  itemId: string,
  ...extra: unknown[]
): void {
  callLocalMutation(type, 'enqueueUpdate', itemId, extra)
}

export function enqueueLocalSyncDelete(
  type: LocalSyncType,
  itemId: string,
  ...extra: unknown[]
): void {
  callLocalMutation(type, 'enqueueDelete', itemId, extra)
}

export function removePendingNoteSyncItems(noteId: string): number {
  return getNoteSyncService()?.removeQueueItems(noteId) ?? 0
}

export function syncSettingsFieldUpdate(fieldPath: string, value: unknown): void {
  const manager = getSettingsSyncManager()
  if (!manager) return
  manager.updateField(fieldPath, value, 'local')
}
