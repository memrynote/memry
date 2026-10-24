import type * as Y from 'yjs'
import type { WritebackSource } from './crdt-writeback'

/**
 * The write-back operations the CRDT provider drives.
 *
 * crdt-writeback serializes live docs, so it reads them back through the
 * provider; the provider in turn schedules, cancels and flushes those
 * write-backs. Importing each other would be a cycle, so the provider calls
 * through this port and crdt-writeback registers itself when it loads. The
 * main entry imports crdt-writeback at startup, ahead of any provider use.
 */
export interface CrdtWritebackPort {
  scheduleWriteback(
    noteId: string,
    doc: Y.Doc,
    source: WritebackSource,
    remoteEditedAtMs?: number
  ): void
  cancelWriteback(noteId: string): void
  writebackNow(noteId: string, doc: Y.Doc): Promise<void>
  flushPendingWritebacks(): Promise<void>
  resetWritebackState(): void
}

let port: CrdtWritebackPort | null = null

export function registerCrdtWritebackPort(next: CrdtWritebackPort): void {
  port = next
}

export function crdtWriteback(): CrdtWritebackPort {
  if (!port) {
    throw new Error('CRDT write-back is not registered: crdt-writeback was never loaded')
  }
  return port
}
