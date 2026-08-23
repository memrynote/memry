import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { eq } from 'drizzle-orm'
import { canvases } from '@memry/db-schema/data-schema'
import type { VectorClock } from '@memry/contracts/sync-api'
import { RecordSyncController, incrementClock } from '@memry/sync-core'
import type { SyncQueueManager } from './queue'


interface CanvasSyncDeps {
  queue: SyncQueueManager
  db: DrizzleDb
  getDeviceId: () => string | null
}

let instance: CanvasSyncService | null = null

export function initCanvasSyncService(deps: CanvasSyncDeps): CanvasSyncService {
  instance = new CanvasSyncService(deps)
  return instance
}

export function getCanvasSyncService(): CanvasSyncService | null {
  return instance
}

export function resetCanvasSyncService(): void {
  instance = null
}

/**
 * Local-mutation → sync-queue bridge for the `canvas` record type.
 *
 * The queue payload built by `serialize` is metadata-only (no scene): the
 * authoritative, scene-bearing push payload is rebuilt with the vault key by
 * `canvas-handler.buildPushPayload` at push time (the encrypted at-rest
 * snapshot can't be decrypted here without the key). A scene-less fallback is
 * safe — the receiver skips it (the apply use site requires `scene`) instead of
 * clobbering good ink.
 */
export class CanvasSyncService {
  private controller: RecordSyncController<Record<string, unknown>, [], []>

  constructor(private readonly deps: CanvasSyncDeps) {
    this.controller = new RecordSyncController({
      type: 'canvas',
      queue: deps.queue,
      getDeviceId: deps.getDeviceId,
      // Raw load (no deletedAt filter): the delete path needs the still-present
      // tombstone row to build its delete payload.
      load: (id) =>
        deps.db.select().from(canvases).where(eq(canvases.id, id)).get() as
          | Record<string, unknown>
          | undefined,
      applyLocalChange: ({ itemId, local, deviceId }) => {
        const existingClock = (local.clock as VectorClock) ?? {}
        const newClock = incrementClock(existingClock, deviceId)
        deps.db.update(canvases).set({ clock: newClock }).where(eq(canvases.id, itemId)).run()
        return { ...local, clock: newClock }
      },
      serialize: (local) => ({
        id: local.id,
        vaultId: local.vaultId,
        title: (local.title as string | null) ?? null,
        clock: local.clock,
        deletedAt: (local.deletedAt as number | null) ?? null
      }),
      buildDeletePayload: ({ itemId, local, deviceId }) => {
        if (!local) return null
        const bumped = incrementClock((local.clock as VectorClock) ?? {}, deviceId)
        // Persist the bumped clock on the tombstone so a later concurrent edit
        // resolves against the delete's clock (delete wins over older state).
        deps.db.update(canvases).set({ clock: bumped }).where(eq(canvases.id, itemId)).run()
        return JSON.stringify({
          id: itemId,
          vaultId: local.vaultId,
          clock: bumped,
          deletedAt: (local.deletedAt as number | null) ?? null
        })
      }
    })
  }

  enqueueCreate(canvasId: string): void {
    this.controller.enqueueCreate(canvasId)
  }

  enqueueUpdate(canvasId: string): void {
    this.controller.enqueueUpdate(canvasId)
  }

  enqueueDelete(canvasId: string): void {
    this.controller.enqueueDelete(canvasId)
  }

  getDeviceId(): string | null {
    return this.deps.getDeviceId()
  }

  /**
   * Advance the local clock WITHOUT enqueueing a push. Used when a save is kept
   * locally but is too large to sync (§5.6): if the clock stayed put, a later
   * remote edit would dominate it and silently overwrite the retained local
   * scene (a clean `apply`, no conflict copy). Bumping makes that edit resolve
   * as concurrent instead, so the local ink survives as a conflict copy.
   */
  bumpClockLocalOnly(canvasId: string): void {
    const deviceId = this.deps.getDeviceId()
    if (!deviceId) return
    const row = this.deps.db
      .select({ clock: canvases.clock })
      .from(canvases)
      .where(eq(canvases.id, canvasId))
      .get()
    if (!row) return
    const next = incrementClock((row.clock as VectorClock) ?? {}, deviceId)
    this.deps.db.update(canvases).set({ clock: next }).where(eq(canvases.id, canvasId)).run()
  }

  /**
   * Enqueue a create push for a conflict-copy row minted inside a pull-apply
   * transaction (see canvas-handler §5.4). The handler already minted the row's
   * fresh clock and built the full (scene-bearing) payload, so this bypasses the
   * controller's local-clock bump and serialize.
   */
  enqueueConflictCopyPush(canvasId: string, payload: string): void {
    this.deps.queue.enqueue({
      type: 'canvas',
      itemId: canvasId,
      operation: 'create',
      payload,
      priority: 0
    })
  }
}
