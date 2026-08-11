import type { ProjectionEvent } from './types'

/**
 * Per-lane queue cap (#992).
 *
 * A lane that backs up past this many *distinct* pending entities is already
 * pathological — the embedding lane awaits a ~23MB model load plus per-note CPU
 * inference, and every queued `note.upserted` pins that note's whole body. An
 * unbounded queue turns that backlog into an OOM, so the oldest event is dropped
 * instead. Drops are counted so the runtime can log them, and every projector
 * has a `rebuild()` / `reconcile()` repair path for the lost work.
 */
export const DEFAULT_PROJECTION_QUEUE_LIMIT = 2000

/** Rebase the backing array once this many consumed slots have piled up. */
const COMPACT_AFTER = 512

/**
 * The entity an event is about. Two events sharing an entity key *and* a type
 * are redundant: the newer payload fully supersedes the older one.
 */
function entityKey(event: ProjectionEvent): string {
  switch (event.type) {
    case 'note.upserted':
      return `note:${event.note.noteId}`
    case 'note.deleted':
      return `note:${event.noteId}`
    case 'task.upserted':
    case 'task.deleted':
      return `task:${event.taskId}`
    default:
      return `inbox:${event.itemId}`
  }
}

interface PendingEntry {
  /** Index into `queue` of the newest still-queued event for this entity. */
  index: number
  type: ProjectionEvent['type']
}

export class ProjectionBus {
  private queue: (ProjectionEvent | undefined)[] = []
  private head = 0
  private newestByEntity = new Map<string, PendingEntry>()
  private dropped = 0
  private readonly limit: number

  constructor(limit: number = DEFAULT_PROJECTION_QUEUE_LIMIT) {
    this.limit = Math.max(1, limit)
  }

  enqueue(event: ProjectionEvent): void {
    const key = entityKey(event)
    const newest = this.newestByEntity.get(key)

    // Newest-wins, in place: an already-queued event of the same type for the
    // same entity is fully superseded, so overwrite it instead of queueing a
    // second copy of the payload. Only the entity's *newest* pending event is a
    // candidate, so a `note.deleted` can never be reordered behind a later
    // `note.upserted` — a type change re-anchors the entity to the tail.
    if (newest && newest.type === event.type) {
      this.queue[newest.index] = event
      return
    }

    if (this.size >= this.limit) {
      this.dequeue()
      this.dropped++
    }

    this.queue.push(event)
    this.newestByEntity.set(key, { index: this.queue.length - 1, type: event.type })
  }

  dequeue(): ProjectionEvent | undefined {
    if (this.head >= this.queue.length) {
      return undefined
    }

    const event = this.queue[this.head]
    this.queue[this.head] = undefined
    this.head++

    if (event) {
      const key = entityKey(event)
      const newest = this.newestByEntity.get(key)
      if (newest && newest.index < this.head) {
        this.newestByEntity.delete(key)
      }
    }

    if (this.head >= this.queue.length) {
      this.clear()
    } else if (this.head >= COMPACT_AFTER) {
      const consumed = this.head
      this.queue = this.queue.slice(consumed)
      this.head = 0
      for (const entry of this.newestByEntity.values()) {
        entry.index -= consumed
      }
    }

    return event
  }

  clear(): void {
    this.queue = []
    this.head = 0
    this.newestByEntity.clear()
  }

  /** Number of events dropped to stay under the cap since the last read. */
  takeDroppedCount(): number {
    const dropped = this.dropped
    this.dropped = 0
    return dropped
  }

  get size(): number {
    return this.queue.length - this.head
  }
}
