import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import type { VectorClock } from '@memry/contracts/sync-api'
import { DEVICE_LOCAL_CALENDAR_PROVIDERS } from '@memry/contracts/calendar-api'
import { RecordSyncController, incrementClock, withIncrementedClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'
import { nextLocalClock } from './tombstone-clocks'

/**
 * A device-local provider's source row (`sourceScope: 'device'`, the macOS
 * Calendar provider) never leaves the device: no create, update or delete is
 * ever enqueued for it, so other platforms and older builds never see it.
 */
function isDeviceLocalSource(row: { provider?: unknown } | null | undefined): boolean {
  return (
    typeof row?.provider === 'string' &&
    DEVICE_LOCAL_CALENDAR_PROVIDERS.sources.includes(row.provider)
  )
}

function parseSnapshot(snapshotPayload: string): { provider?: unknown } | null {
  try {
    const parsed = JSON.parse(snapshotPayload) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as { provider?: unknown }) : null
  } catch {
    return null
  }
}

interface CalendarSourceSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CalendarSourceSyncService | null = null

export function initCalendarSourceSyncService(
  deps: CalendarSourceSyncDeps
): CalendarSourceSyncService {
  instance = new CalendarSourceSyncService(deps)
  return instance
}

export function getCalendarSourceSyncService(): CalendarSourceSyncService | null {
  return instance
}

export function resetCalendarSourceSyncService(): void {
  instance = null
}

export class CalendarSourceSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], [string?]>

  constructor(deps: CalendarSourceSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'calendar_source',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      load: (id) =>
        deps.db.select().from(calendarSources).where(eq(calendarSources.id, id)).get() as
          Record<string, unknown> | undefined,
      applyLocalChange: ({ itemId, local, deviceId, operation }) => {
        const nextClock = nextLocalClock(
          deps.db,
          'calendar_source',
          itemId,
          local.clock as VectorClock | null,
          deviceId,
          operation
        )

        deps.db
          .update(calendarSources)
          .set({ clock: nextClock })
          .where(eq(calendarSources.id, itemId))
          .run()

        return { ...local, clock: nextClock }
      },
      serialize: (local) => local,
      shouldSkip: (local) => isDeviceLocalSource(local),
      buildDeletePayload: ({ itemId, local, extra, deviceId }) => {
        const snapshotPayload = extra[0]
        // The row may already be gone; its snapshot still says where it came from.
        if (snapshotPayload && isDeviceLocalSource(parseSnapshot(snapshotPayload))) return null
        if (snapshotPayload) return withIncrementedClock(snapshotPayload, deviceId)
        if (local) return withIncrementedClock(JSON.stringify(local), deviceId)
        return JSON.stringify({ id: itemId, clock: incrementClock({}, deviceId) })
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
