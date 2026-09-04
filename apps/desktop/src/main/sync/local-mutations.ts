import type { SyncItemType } from '@memry/contracts/sync-api'
import { createSyncAdapterRegistry } from '@memry/sync-core'
import { getDatabase } from '../database'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createLogger } from '../lib/logger'
import { trackMainLog } from '../telemetry/diagnostics'
import { shouldEmitThrottled } from '../telemetry/throttle'
import { isSyncEligible } from '@memry/sync-client/sync-eligibility'
import {
  buildContentDeletePayload,
  clearPendingDelete,
  listPendingDeletes,
  recordPendingDelete
} from './pending-deletes'
import {
  incrementBookmarkClockOffline,
  incrementTemplateClockOffline,
  incrementHomePageClockOffline,
  incrementCustomIconClockOffline,
  incrementCanvasClockOffline,
  incrementCanvasFolderClockOffline,
  incrementFilterClockOffline,
  incrementInboxClockOffline,
  incrementNoteClockOffline,
  incrementProjectClocksOffline,
  incrementReminderClockOffline,
  incrementTaskActivityClockOffline,
  incrementTaskClocksOffline
} from '@memry/sync-client/offline-clock'
import { getBookmarkSyncService } from '@memry/sync-client/bookmark-sync'
import { getTemplateSyncService } from '@memry/sync-client/template-sync'
import { getHomePageSyncService } from '@memry/sync-client/home-page-sync'
import { getCustomIconSyncService } from '@memry/sync-client/custom-icon-sync'
import { getCanvasSyncService } from '@memry/sync-client/canvas-sync'
import { getCanvasFolderSyncService } from '@memry/sync-client/canvas-folder-sync'
import { getFilterSyncService } from '@memry/sync-client/filter-sync'
import { getInboxSyncService } from '@memry/sync-client/inbox-sync'
import { getJournalSyncService } from './journal-sync'
import { getNoteSyncService } from './note-sync'
import { getProjectSyncService } from '@memry/sync-client/project-sync'
import { getReminderSyncService } from '@memry/sync-client/reminder-sync'
import { getSettingsSyncManager } from '@memry/sync-client/settings-sync'
import { getTagDefinitionSyncService } from '@memry/sync-client/tag-definition-sync'
import { getPropertyDefinitionSyncService } from '@memry/sync-client/property-definition-sync'
import { getTagCategorySyncService } from '@memry/sync-client/tag-category-sync'
import { getTaskSyncService } from '@memry/sync-client/task-sync'
import { getTaskActivitySyncService } from '@memry/sync-client/task-activity-sync'
import { getFolderConfigSyncService } from '@memry/sync-client/folder-config-sync'
import { getCalendarEventSyncService } from './calendar-event-sync'
import { getCalendarSourceSyncService } from '@memry/sync-client/calendar-source-sync'
import { getCalendarBindingSyncService } from '@memry/sync-client/calendar-binding-sync'
import { getCalendarExternalEventSyncService } from '@memry/sync-client/calendar-external-event-sync'

const log = createLogger('LocalSync')

type LocalSyncType = Exclude<SyncItemType, 'attachment'>

/**
 * One tripwire per type per half hour.
 *
 * The signal is per-mutation, and two of its emitters fire on a timer: the
 * Google Calendar poll runs every 5 minutes and calls this once per polled row,
 * and a source stuck in a sync-error loop adds one more per failed sync. On the
 * installs in #1579 that produced ~30k events in ten days and buried every
 * other desktop error signal. A drop is a *state* — the runtime is not up — so
 * the first report inside a window says everything the thousandth would.
 */
const DROP_TRIPWIRE_THROTTLE_MS = 30 * 60 * 1000

function trackMutationDrop(throttleKey: string, type: LocalSyncType, message: string): void {
  if (!shouldEmitThrottled(`${throttleKey}:${type}`, DROP_TRIPWIRE_THROTTLE_MS)) return
  log.warn(message, { type })
  trackMainLog('warn', {
    scope: 'LocalSync',
    action: 'local_mutation_dropped',
    errorCode: type
  })
}

/**
 * Telemetry tripwire for the #969/#970 bug class: a mutation raised while the
 * sync runtime is down (or before services initialize) on a type with no
 * offline fallback is a silent no-op — the edit never syncs. Returns the
 * service unchanged so `?.` call sites keep their exact behavior; a null
 * service is counted per type before the no-op happens.
 *
 * Silent when the install does not sync at all (free plan, signed out, no
 * confirmed recovery phrase). That is not a dropped edit — the services are
 * null for the whole session by policy, there is no peer to tell, and the
 * "tripwire" only fires forever without ever describing a bug (#1579).
 */
function svcOrTrackDrop<T>(
  type: LocalSyncType,
  service: T | null | undefined
): T | null | undefined {
  if (!service && isSyncEligible()) {
    trackMutationDrop(
      'local_mutation_dropped',
      type,
      'Local mutation dropped — sync service not running'
    )
  }
  return service
}

interface DeleteEnqueuer {
  enqueueDelete(itemId: string, snapshotPayload?: string): void
}

/**
 * Delete is the one mutation with no recovery path anywhere: create and update
 * fall back to an offline clock bump that `recoverDirtyItems` re-pushes, but a
 * delete raised while the runtime was down left no queue row, no tombstone and
 * no dirty marker — so on a paid multi-device install the deleted item simply
 * came back from the other device (#1579).
 *
 * When the service is down the delete is written to `sync_pending_deletes`
 * instead, and `flushPendingLocalDeletes` replays it at the next runtime start.
 */
function enqueueDeleteOrDefer(
  type: LocalSyncType,
  service: DeleteEnqueuer | null | undefined,
  itemId: string,
  snapshotPayload?: string
): void {
  if (service) {
    service.enqueueDelete(itemId, snapshotPayload)
    return
  }

  deferDelete(type, itemId, snapshotPayload)
}

function deferDelete(type: LocalSyncType, itemId: string, snapshotPayload?: string): void {
  // Expected absence: this install has no sync runtime by policy, so there is
  // no peer that still holds the item and nothing would ever drain the row.
  if (!isSyncEligible()) return

  try {
    const db = getDatabase()
    // Notes and journals derive their tombstone from a row that is deleted
    // moments after this call, so it has to be captured now; every other type
    // was handed its snapshot by the caller.
    const payload =
      snapshotPayload ??
      (type === 'note' || type === 'journal' ? buildContentDeletePayload(db, itemId) : null)

    if (!payload) {
      // Nothing durable to keep. Either the item never reached the server (no
      // clock, local-only, no device) — in which case there is nothing to
      // tombstone — or the caller passed no snapshot for a type that rebuilds
      // its payload from a row this code cannot read. The second is a real
      // remaining hole, so it stays reported.
      trackMutationDrop(
        'local_delete_undeferrable',
        type,
        'Delete dropped — sync service not running and no payload to defer'
      )
      return
    }

    recordPendingDelete(db, type, itemId, payload)
  } catch (err) {
    log.warn('Failed to record a delete raised while the sync runtime was down', {
      type,
      itemId,
      error: err
    })
  }
}

/**
 * Replay the deletes recorded while the sync runtime was down. Runs from
 * `recoverDirtyItems` at every runtime start — the same "re-push what this
 * device still owes the server" pass, for the one operation that had none.
 *
 * Record types go back through the ordinary registry call so each type keeps
 * its own clock rule and its own guards (inbox refuses to push a delete for a
 * local-only snapshot). Notes and journals cannot: their services build the
 * body from a row that is gone, so the body captured at delete time is handed
 * straight to the service's queue.
 *
 * Never loses a row it cannot deliver: a record type whose service is still
 * missing re-records itself through `deferDelete`, and a content type is left
 * untouched until its service exists.
 */
export function flushPendingLocalDeletes(db: DrizzleDb): number {
  const pending = listPendingDeletes(db)
  if (pending.length === 0) return 0

  let flushed = 0
  for (const item of pending) {
    try {
      if (item.type === 'note' || item.type === 'journal') {
        const service = item.type === 'note' ? getNoteSyncService() : getJournalSyncService()
        if (!service) continue
        clearPendingDelete(db, item.type, item.itemId)
        service.enqueueRecoveredDelete(item.itemId, item.payload)
      } else {
        // Cleared first: the replay re-records it when the service is somehow
        // still down, and clearing afterwards would delete what was just
        // written back.
        clearPendingDelete(db, item.type, item.itemId)
        enqueueLocalSyncDelete(item.type as LocalSyncType, item.itemId, item.payload)
      }

      flushed++
    } catch (err) {
      log.warn('Failed to replay a delete raised while the sync runtime was down', {
        type: item.type,
        itemId: item.itemId,
        error: err
      })
    }
  }

  if (flushed > 0) {
    log.info('Replayed deletes raised while the sync runtime was down', { count: flushed })
  }
  return flushed
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
        enqueueDeleteOrDefer('task', getTaskSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('project', getProjectSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('inbox', getInboxSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('filter', getFilterSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('template', getTemplateSyncService(), itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'home_page',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getHomePageSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementHomePageClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getHomePageSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementHomePageClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        enqueueDeleteOrDefer('home_page', getHomePageSyncService(), itemId, snapshotPayload)
      }
    }
  },
  {
    type: 'custom_icon',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        const service = getCustomIconSyncService()
        if (service) {
          service.enqueueCreate(itemId)
          return
        }

        incrementCustomIconClockOffline(getDatabase(), itemId)
      },
      enqueueUpdate(itemId: string): void {
        const service = getCustomIconSyncService()
        if (service) {
          service.enqueueUpdate(itemId)
          return
        }

        incrementCustomIconClockOffline(getDatabase(), itemId)
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        if (!snapshotPayload) return
        enqueueDeleteOrDefer('custom_icon', getCustomIconSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('bookmark', getBookmarkSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer('reminder', getReminderSyncService(), itemId, snapshotPayload)
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
        // No deferral: unlike notes and journals, a canvas tombstone is built by
        // CanvasSyncService from the `canvases` row AND writes the bumped clock
        // back to it, so capturing it here would mean duplicating that service's
        // rule. Still the tripwire, still reported (#1579).
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
        enqueueDeleteOrDefer('canvas_folder', getCanvasFolderSyncService(), itemId, snapshotPayload)
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
        const service = getNoteSyncService()
        if (service) {
          service.enqueueDelete(itemId)
          return
        }

        deferDelete('note', itemId)
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

        const service = getJournalSyncService()
        if (service) {
          service.enqueueDelete(itemId, date)
          return
        }

        // The date is not put on the wire (see JournalSyncService), so the
        // deferred tombstone carries the same body a note's does.
        deferDelete('journal', itemId)
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
        enqueueDeleteOrDefer(
          'tag_definition',
          getTagDefinitionSyncService(),
          itemId,
          snapshotPayload
        )
      }
    }
  },
  {
    type: 'property_definition',
    kind: 'record',
    local: {
      enqueueCreate(itemId: string): void {
        svcOrTrackDrop('property_definition', getPropertyDefinitionSyncService())?.enqueueCreate(
          itemId
        )
      },
      enqueueUpdate(itemId: string): void {
        svcOrTrackDrop('property_definition', getPropertyDefinitionSyncService())?.enqueueUpdate(
          itemId
        )
      },
      enqueueDelete(itemId: string, snapshotPayload?: string): void {
        enqueueDeleteOrDefer(
          'property_definition',
          getPropertyDefinitionSyncService(),
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
        enqueueDeleteOrDefer('tag_category', getTagCategorySyncService(), itemId, snapshotPayload)
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
        // No deferral: settings is a singleton with no item id and no snapshot,
        // so there is nothing to capture for a later replay (#1579).
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
        enqueueDeleteOrDefer('folder_config', getFolderConfigSyncService(), itemId, snapshotPayload)
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
        enqueueDeleteOrDefer(
          'calendar_event',
          getCalendarEventSyncService(),
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
        enqueueDeleteOrDefer(
          'calendar_source',
          getCalendarSourceSyncService(),
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
        enqueueDeleteOrDefer(
          'calendar_binding',
          getCalendarBindingSyncService(),
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
        enqueueDeleteOrDefer(
          'calendar_external_event',
          getCalendarExternalEventSyncService(),
          itemId,
          snapshotPayload
        )
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
    // Its own throttle key: this one is a wiring bug (a type with no adapter),
    // not a runtime-state drop, so it must not be silenced by — or silence —
    // the tripwire above.
    if (shouldEmitThrottled(`local_mutation_adapter_missing:${type}`, DROP_TRIPWIRE_THROTTLE_MS)) {
      log.warn('Missing local sync adapter', { type, method, itemId })
      trackMainLog('warn', {
        scope: 'LocalSync',
        action: 'local_mutation_dropped',
        errorCode: type
      })
    }
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
