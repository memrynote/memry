import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { DEVICE_LOCAL_CALENDAR_PROVIDERS } from '@memry/contracts/calendar-api'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { deleteFromLocalRow } from './delete-fallback'
import { nextLocalClock } from './tombstone-clocks'

function sourceIdOf(row: { sourceId?: unknown } | null | undefined): string | null {
  return typeof row?.sourceId === 'string' ? row.sourceId : null
}

function parseSnapshot(snapshotPayload: string): { sourceId?: unknown } | null {
  try {
    const parsed = JSON.parse(snapshotPayload) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as { sourceId?: unknown }) : null
  } catch {
    return null
  }
}

interface CalendarExternalEventSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CalendarExternalEventSyncService | null = null

export function initCalendarExternalEventSyncService(
  deps: CalendarExternalEventSyncDeps
): CalendarExternalEventSyncService {
  instance = new CalendarExternalEventSyncService(deps)
  return instance
}

export function getCalendarExternalEventSyncService(): CalendarExternalEventSyncService | null {
  return instance
}

export function resetCalendarExternalEventSyncService(): void {
  instance = null
}

export class CalendarExternalEventSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CalendarExternalEventSyncDeps) {
    /**
     * Events mirrored from a device-local provider (`mirrorScope: 'device'`:
     * ICS feeds, the macOS Calendar provider) never leave the device. A source
     * row that is already gone cannot be classified, so that case is let
     * through, as the controller does for any row it cannot load.
     */
    const isDeviceLocalMirror = (sourceId: string | null): boolean => {
      if (!sourceId) return false
      const source = deps.db
        .select({ provider: calendarSources.provider })
        .from(calendarSources)
        .where(eq(calendarSources.id, sourceId))
        .get()
      return source ? DEVICE_LOCAL_CALENDAR_PROVIDERS.mirrors.includes(source.provider) : false
    }

    this.controller = new RecordSyncController({
      type: 'calendar_external_event',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db
          .select()
          .from(calendarExternalEvents)
          .where(eq(calendarExternalEvents.id, id))
          .get() as Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation }) => {
        const nextClock = nextLocalClock(
          deps.db,
          'calendar_external_event',
          itemId,
          local.clock as VectorClock | null,
          deviceId,
          operation
        )

        deps.db
          .update(calendarExternalEvents)
          .set({ clock: nextClock })
          .where(eq(calendarExternalEvents.id, itemId))
          .run()

        return { ...local, clock: nextClock }
      },
      serialize: (local) => local,
      shouldSkip: (local) => isDeviceLocalMirror(sourceIdOf(local)),
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        if (snapshotPayload && isDeviceLocalMirror(sourceIdOf(parseSnapshot(snapshotPayload)))) {
          return null
        }
        if (snapshotPayload) return withIncrementedClock(snapshotPayload, deviceId)
        return deleteFromLocalRow('calendar_external_event', itemId, local, deviceId)
      }
    })
  }

  enqueueCreate(id: string): void {
    this.controller.enqueueCreate(id)
  }

  enqueueUpdate(id: string): void {
    this.controller.enqueueUpdate(id)
  }

  enqueueDelete(id: string, snapshotPayload?: string): void {
    this.controller.enqueueDelete(id, snapshotPayload)
  }
}
