import * as Y from 'yjs'

export type BroadcastFn = (noteId: string, mergedUpdate: Uint8Array) => void

export class MicrotaskBatchBroadcaster {
  private queue = new Map<string, Uint8Array[]>()
  private flushScheduled = new Set<string>()
  private broadcastFn: BroadcastFn

  constructor(broadcastFn: BroadcastFn) {
    this.broadcastFn = broadcastFn
  }

  enqueue(noteId: string, update: Uint8Array): void {
    let pending = this.queue.get(noteId)
    if (!pending) {
      pending = []
      this.queue.set(noteId, pending)
    }
    pending.push(update)

    if (!this.flushScheduled.has(noteId)) {
      this.flushScheduled.add(noteId)
      queueMicrotask(() => this.flush(noteId))
    }
  }

  flush(noteId: string): void {
    this.flushScheduled.delete(noteId)
    const pending = this.queue.get(noteId)
    if (!pending || pending.length === 0) return
    this.queue.delete(noteId)

    const merged = pending.length === 1 ? pending[0] : Y.mergeUpdates(pending)
    this.broadcastFn(noteId, merged)
  }

  flushAll(): void {
    for (const noteId of [...this.queue.keys()]) {
      this.flush(noteId)
    }
  }

  hasPending(noteId: string): boolean {
    const pending = this.queue.get(noteId)
    return !!pending && pending.length > 0
  }
}
