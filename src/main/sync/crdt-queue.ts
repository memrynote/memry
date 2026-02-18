import { createLogger } from '../lib/logger'

const log = createLogger('CrdtUpdateQueue')

const FLUSH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50

interface BufferedUpdate {
  noteId: string
  rawUpdate: Uint8Array
  timestamp: number
}

export class CrdtUpdateQueue {
  private buffers = new Map<string, BufferedUpdate[]>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushingNotes = new Set<string>()
  private pushFn: ((noteId: string, updates: Uint8Array[]) => Promise<void>) | null = null

  start(pushFn: (noteId: string, updates: Uint8Array[]) => Promise<void>): void {
    this.pushFn = pushFn
    this.flushTimer = setInterval(() => {
      this.flushAll()
    }, FLUSH_INTERVAL_MS)
    log.info('CrdtUpdateQueue started')
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
    this.flushAll()
    log.info('CrdtUpdateQueue stopped')
  }

  enqueue(noteId: string, rawUpdate: Uint8Array): void {
    let buffer = this.buffers.get(noteId)
    if (!buffer) {
      buffer = []
      this.buffers.set(noteId, buffer)
    }
    buffer.push({ noteId, rawUpdate, timestamp: Date.now() })

    if (buffer.length >= MAX_BATCH_SIZE) {
      this.flushNote(noteId)
    }
  }

  getPendingCount(): number {
    let count = 0
    for (const buffer of this.buffers.values()) {
      count += buffer.length
    }
    return count
  }

  private flushAll(): void {
    for (const noteId of this.buffers.keys()) {
      this.flushNote(noteId)
    }
  }

  private flushNote(noteId: string): void {
    if (this.flushingNotes.has(noteId)) return

    const buffer = this.buffers.get(noteId)
    if (!buffer || buffer.length === 0) return

    const updates = buffer.splice(0, MAX_BATCH_SIZE)
    if (buffer.length === 0) this.buffers.delete(noteId)

    if (!this.pushFn) {
      log.warn('No push function registered, dropping updates', { noteId, count: updates.length })
      return
    }

    this.flushingNotes.add(noteId)
    this.pushFn(noteId, updates.map((u) => u.rawUpdate))
      .catch((err) => {
        log.error('Failed to push CRDT updates', { noteId, error: err })
        let existing = this.buffers.get(noteId)
        if (!existing) {
          existing = []
          this.buffers.set(noteId, existing)
        }
        existing.unshift(...updates)
      })
      .finally(() => {
        this.flushingNotes.delete(noteId)
      })
  }
}
