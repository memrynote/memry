/**
 * Platform-free replacement for the slice of node's EventEmitter the sync
 * engine actually uses (`on`/`off`/`once`/`emit`/`removeListener`/
 * `removeAllListeners`/`listenerCount`/`setMaxListeners`). Matches node where
 * it matters to callers: `emit` returns whether anyone was listening
 * (attachment-events depends on that boolean), and emit iterates a snapshot so
 * listeners added or removed mid-emit do not affect the current dispatch.
 * Deliberate divergence: no throw on an unlistened `'error'` emit — the one
 * class that emits `'error'` (WebSocketManager) installs its own listener in
 * its constructor, so the node crash path was already unreachable.
 */
// `any[]`, exactly like node's own EventEmitter listener type: subclasses
// expose typed overloads (e.g. `(evt: SavedEvent) => void`) that must stay
// assignable, and `unknown[]` rejects them by parameter contravariance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type SyncEventListener = (...args: any[]) => void

export class SyncEventEmitter {
  private listenersByEvent = new Map<string, SyncEventListener[]>()

  on(event: string, listener: SyncEventListener): this {
    const list = this.listenersByEvent.get(event)
    if (list) list.push(listener)
    else this.listenersByEvent.set(event, [listener])
    return this
  }

  once(event: string, listener: SyncEventListener): this {
    const wrapper: SyncEventListener = (...args) => {
      this.off(event, wrapper)
      listener(...args)
    }
    return this.on(event, wrapper)
  }

  off(event: string, listener: SyncEventListener): this {
    const list = this.listenersByEvent.get(event)
    if (!list) return this
    const idx = list.indexOf(listener)
    if (idx !== -1) list.splice(idx, 1)
    if (list.length === 0) this.listenersByEvent.delete(event)
    return this
  }

  removeListener(event: string, listener: SyncEventListener): this {
    return this.off(event, listener)
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.listenersByEvent.clear()
    else this.listenersByEvent.delete(event)
    return this
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listenersByEvent.get(event)
    if (!list || list.length === 0) return false
    for (const listener of [...list]) listener(...args)
    return true
  }

  listenerCount(event: string): number {
    return this.listenersByEvent.get(event)?.length ?? 0
  }

  /**
   * Bookkeeping only — nothing here warns or throws at the ceiling. The value
   * is kept because the listener-budget test asserts each sync emitter
   * declares a deliberately low ceiling (node's default is 10).
   */
  private maxListeners = 10

  setMaxListeners(max: number): this {
    this.maxListeners = max
    return this
  }

  getMaxListeners(): number {
    return this.maxListeners
  }

  eventNames(): string[] {
    return [...this.listenersByEvent.keys()]
  }
}
