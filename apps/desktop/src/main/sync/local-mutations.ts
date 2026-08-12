import type { SyncItemType } from '@memry/contracts/sync-api'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import {
  incrementBookmarkClockOffline,
  incrementTemplateClockOffline,
  incrementCanvasClockOffline,
  incrementCanvasFolderClockOffline,
  incrementFilterClockOffline,
  incrementInboxClockOffline,
  incrementNoteClockOffline,
  incrementProjectClocksOffline,
  incrementReminderClockOffline,
  incrementTaskActivityClockOffline,
  incrementTaskClocksOffline
} from './offline-clock'
import { getBookmarkSyncService } from './bookmark-sync'
import { getTemplateSyncService } from './template-sync'
import { getCanvasSyncService } from './canvas-sync'
import { getCanvasFolderSyncService } from './canvas-folder-sync'
import { getFilterSyncService } from './filter-sync'
import { getInboxSyncService } from './inbox-sync'
import { getJournalSyncService } from './journal-sync'
import { getNoteSyncService } from './note-sync'
import { getProjectSyncService } from './project-sync'
import { getReminderSyncService } from './reminder-sync'
import { getSettingsSyncManager } from './settings-sync'
import { getTagDefinitionSyncService } from './tag-definition-sync'
import { getTagCategorySyncService } from './tag-category-sync'
import { getTaskSyncService } from './task-sync'
import { getTaskActivitySyncService } from './task-activity-sync'
import { getFolderConfigSyncService } from './folder-config-sync'
import { getCalendarEventSyncService } from './calendar-event-sync'
import { getCalendarSourceSyncService } from './calendar-source-sync'
import { getCalendarBindingSyncService } from './calendar-binding-sync'
import { getCalendarExternalEventSyncService } from './calendar-external-event-sync'

const log = createLogger('LocalSync')

type LocalSyncType = Exclude<SyncItemType, 'attachment'>

/**
 * Telemetry tripwire for the #969/#970 bug class: a mutation raised while the
 * sync runtime is down (or before services initialize) on a type with no
 * offline fallback is a silent no-op — the edit never syncs. Returns the
 * service unchanged so `?.` call sites keep their exact behavior; a null
 * service is counted per type before the no-op happens.
 */
function svcOrTrackDrop<T>(
  type: LocalSyncType,
  service: T | null | undefined
): T | null | undefined {
  if (!service) {
    log.warn('Local mutation dropped — sync service not running', { type })
    trackMainLog('warn', {
      scope: 'LocalSync',
      action: 'local_mutation_dropped',
      errorCode: type
    })
  }
  return service
}

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
        svcOrTrackDrop('task', getTaskSyncService())?.enqueueDelete(itemId, snapshotPayload)
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
        svcOrTrackDrop('project', getProjectSyncService())?.enqueueDelete(itemId, snapshotPayload)
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
        svcOrTrackDrop('inbox', getInboxSyncService())?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    // Append-only: only `create` reaches the wire. `update` cannot happen (rows
    // are immutable) and `delete` is deliberately local — every device reaches
    // the same pruned state from the shared retention age rule, so pushing the
    // deletes would only duplicate work. Both are no-ops rather than missing so
    // a future caller gets silence, not a crash.
    type: 'task_activity',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getTaskActivitySyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementTaskActivityClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(): void {
        // Rows are immutable — there is nothing to push.
      },
      enqueueDelete(): void {
        // Retention prunes locally on every device from the same age rule.
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
        svcOrTrackDrop('filter', getFilterSyncService())?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'template',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getTemplateSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementTemplateClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getTemplateSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementTemplateClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        svcOrTrackDrop('template', getTemplateSyncService())?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'bookmark',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getBookmarkSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementBookmarkClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getBookmarkSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementBookmarkClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        svcOrTrackDrop('bookmark', getBookmarkSyncService())?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'reminder',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getReminderSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementReminderClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getReminderSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementReminderClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        svcOrTrackDrop('reminder', getReminderSyncService())?.enqueueDelete(itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'canvas',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getCanvasSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementCanvasClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getCanvasSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementCanvasClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string): void {
        svcOrTrackDrop('canvas', getCanvasSyncService())?.enqueueDelete(itemId)
      }
    }
  },
  {
    type: 'canvas_folder',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getCanvasFolderSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementCanvasFolderClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getCanvasFolderSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementCanvasFolderClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        svcOrTrackDrop('canvas_folder', getCanvasFolderSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'note',
    kind: 'crdt',
    local: {
      enqueueCreate(itemId: string): void {
        // No offline fallback on purpose: a note that has never been pushed has
        // no clock, and `seedUnclockedNotes` already sweeps those into a create
        // at the next sync runtime start.
        getNoteSyncService()?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getNoteSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        // Notes used to be the one type whose update simply evaporated when the
        // sync runtime was down (quit, vault switch, re-auth). It bites hardest
        // on attachment uploads: the blob is durably queued in the attachment
        // outbox, but `recordUploadedAttachment`'s note push — the thing that
        // tells peers a blob exists to download — was fire-and-forget, so an
        // upload completing during teardown left the image on this device until
        // some unrelated later edit happened to push the note. Marking the note
        // dirty hands the push to `recoverDirtyItems`, which re-pushes it at the
        // next runtime start.
        incrementNoteClockOffline(getDatabase(), itemId)
      },
      enqueueRecoveredUpdate(itemId: string): void {
        getNoteSyncService()?.enqueueRecoveredUpdate(itemId)
      },
      enqueueDelete(itemId: string): void {
        svcOrTrackDrop('note', getNoteSyncService())?.enqueueDelete(itemId)
      }
    }
  },
  {
    type: 'journal',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string, date?: string): void {
        if (!date) return
        svcOrTrackDrop('journal', getJournalSyncService())?.enqueueCreate(itemId, date)
      },
      enqueueUpdate(itemId: string, date?: string): void {
        if (!date) return

        const service = getJournalSyncService()
        if (service) {
          service.enqueueUpdate(itemId, date)
          return
        }

        // Same hole notes had, and worse: journals were also outside the note
        // recovery sweep (`recoverDirtyNotes` filters `journalDate IS NULL`), so
        // a metadata edit raised while the runtime was down (quit, vault switch,
        // re-auth) had nothing left to re-push it — no queue row, no dirty
        // marker, no sweep. Marking the row dirty hands it to
        // `recoverDirtyJournals` at the next runtime start.
        incrementNoteClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, date?: string): void {
        if (!date) return
        svcOrTrackDrop('journal', getJournalSyncService())?.enqueueDelete(itemId, date)
      }
    }
  },
  {
    type: 'tag_definition',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('tag_definition', getTagDefinitionSyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('tag_definition', getTagDefinitionSyncService())?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('tag_definition', getTagDefinitionSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'tag_category',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('tag_category', getTagCategorySyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('tag_category', getTagCategorySyncService())?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('tag_category', getTagCategorySyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'settings',
    kind: 'record',
    local: {
      enqueueCreate(): void {
        svcOrTrackDrop('settings', getSettingsSyncManager())?.enqueueCreate()
      },
      enqueueUpdate(): void {
        svcOrTrackDrop('settings', getSettingsSyncManager())?.enqueueUpdate()
      },
      enqueueDelete(): void {
        svcOrTrackDrop('settings', getSettingsSyncManager())?.enqueueDelete()
      }
    }
  },
  {
    type: 'folder_config',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('folder_config', getFolderConfigSyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('folder_config', getFolderConfigSyncService())?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('folder_config', getFolderConfigSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'calendar_event',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('calendar_event', getCalendarEventSyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string, changedFields?: string[]): void {
        svcOrTrackDrop('calendar_event', getCalendarEventSyncService())?.enqueueUpdate(
          itemId,
          changedFields
        )
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('calendar_event', getCalendarEventSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'calendar_source',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('calendar_source', getCalendarSourceSyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('calendar_source', getCalendarSourceSyncService())?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('calendar_source', getCalendarSourceSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'calendar_binding',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('calendar_binding', getCalendarBindingSyncService())?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('calendar_binding', getCalendarBindingSyncService())?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop('calendar_binding', getCalendarBindingSyncService())?.enqueueDelete(
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'calendar_external_event',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop(
          'calendar_external_event',
          getCalendarExternalEventSyncService()
        )?.enqueueCreate(itemId)
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop(
          'calendar_external_event',
          getCalendarExternalEventSyncService()
        )?.enqueueUpdate(itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        svcOrTrackDrop(
          'calendar_external_event',
          getCalendarExternalEventSyncService()
        )?.enqueueDelete(itemId, snapshotPayload)
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
    trackMainLog('warn', {
      scope: 'LocalSync',
      action: 'local_mutation_dropped',
      errorCode: type
    })
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

/**
 * Advance a canvas's local clock without enqueueing a push — used when a save is
 * kept locally but too large to sync (§5.6), so a later remote edit can't
 * silently clobber the retained scene. Falls back to the offline-clock bump when
 * the sync runtime isn't up.
 */
export function bumpCanvasClockLocalOnly(canvasId: string): void {
  const service = getCanvasSyncService()
  if (service) {
    service.bumpClockLocalOnly(canvasId)
    return
  }

  incrementCanvasClockOffline(getDatabase(), canvasId)
}

export function syncSettingsFieldUpdate(fieldPath: string, value: unknown): void {
  const manager = getSettingsSyncManager()
  if (!manager) return
  manager.updateField(fieldPath, value, 'local')
}
