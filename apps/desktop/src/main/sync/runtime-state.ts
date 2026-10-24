import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { CrdtSnapshotScheduler } from '@memry/sync-client/crdt-snapshot-scheduler'
import type { SyncEngine } from './engine'
import type { NetworkMonitor } from './network'
import type { NoteBodyOutbox } from './note-body-outbox'
import type { WebSocketManager } from './websocket'
import type { SyncWorkerBridge } from './worker-bridge'

// The live sync runtime handle. Kept apart from runtime.ts (which builds and
// tears it down) so the attachment and canvas asset code can ask whether sync
// is up without importing the module that starts every sync service.

export interface SyncRuntimeState {
  queue: SyncQueueManager
  network: NetworkMonitor
  ws: WebSocketManager
  engine: SyncEngine
  noteBodyOutbox: NoteBodyOutbox
  snapshotScheduler: CrdtSnapshotScheduler
  workerBridge: SyncWorkerBridge
  /**
   * Kept so teardown can detach it. The closure reaches this runtime's
   * noteBodyOutbox, and the attachment UploadQueue is a module
   * singleton that holds the NetworkMonitor past a runtime stop — leaving the
   * subscriber attached keeps the whole dead graph reachable.
   */
  onNetworkStatusChanged: (event: { online: boolean }) => void
}

let runtime: SyncRuntimeState | null = null

export function getActiveRuntime(): SyncRuntimeState | null {
  return runtime
}

export function setActiveRuntime(next: SyncRuntimeState | null): void {
  runtime = next
}

export function getSyncEngine(): SyncEngine | null {
  return runtime?.engine ?? null
}

export const getNoteBodyOutbox = (): NoteBodyOutbox | null => runtime?.noteBodyOutbox ?? null

export function getNetworkMonitor(): NetworkMonitor | null {
  return runtime?.network ?? null
}

export const getSyncWebSocket = (): WebSocketManager | null => runtime?.ws ?? null
