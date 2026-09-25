import type { RecordChangesResponse } from '@memry/contracts/sync-api'
import type { ItemRef } from './corrupt-item-tracker'
import { itemRefKey } from './sync-context'

/**
 * The cursor at which a changes page listed each id: the ref's `serverCursor`,
 * or the page's `nextCursor` for a `deleted` id and for a ref from a server that
 * sends no `serverCursor` (pre-#2280). Every row of a page lies in
 * `(cursor, nextCursor]` and every row of a later page lies above that
 * `nextCursor`, so the fallback never ranks a later page's row at or below it.
 */
export function listedCursorOf(changes: RecordChangesResponse): (id: string) => number {
  const exact = new Map<string, number>()
  for (const ref of changes.items) {
    if (ref.serverCursor !== undefined) {
      exact.set(ref.id, Math.max(ref.serverCursor, exact.get(ref.id) ?? 0))
    }
  }
  return (id) => exact.get(id) ?? changes.nextCursor
}

/**
 * The highest listed cursor at which a pull run applied each item (#2429). A
 * later page lists an item again only when a newer version committed during the
 * run, so only an item listed at or below that cursor is a repeat to skip. The
 * newer version goes through the clock-guarded apply like any other row.
 */
export class RunAppliedCursors {
  private readonly applied = new Map<string, number>()
  private readonly deferred = new Map<string, number>()

  covers(ref: ItemRef, listedCursor: number): boolean {
    const applied = this.applied.get(itemRefKey(ref.type, ref.id))
    return applied !== undefined && listedCursor <= applied
  }

  record(ref: ItemRef, listedCursor: number): void {
    const key = itemRefKey(ref.type, ref.id)
    this.applied.set(key, Math.max(listedCursor, this.applied.get(key) ?? 0))
  }

  /** An item whose page apply threw keeps its listed cursor for the end-of-run retry. */
  defer(ref: ItemRef, listedCursor: number): void {
    const key = itemRefKey(ref.type, ref.id)
    this.deferred.set(key, Math.max(listedCursor, this.deferred.get(key) ?? 0))
  }

  recordDeferred(ref: ItemRef): void {
    this.record(ref, this.deferred.get(itemRefKey(ref.type, ref.id)) ?? 0)
  }
}
