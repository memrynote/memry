/**
 * Which notes just received a network update, so an external file edit that
 * lands in the same window can be reported as a concurrent edit.
 *
 * A leaf, apart from crdt-writeback, so the provider (which records an update)
 * and the external feed (which asks) need not import the write-back machinery.
 *
 * @module sync/crdt-network-update
 */

export function sweepExpired(entries: Map<string, number>, ttlMs: number, now: number): void {
  for (const [key, ts] of entries) {
    if (now - ts >= ttlMs) entries.delete(key)
  }
}

const lastNetworkUpdateMs = new Map<string, number>()
let networkUpdatesSweptAt = 0

const CONCURRENT_EDIT_WINDOW_MS = 2000

export function recordNetworkUpdate(noteId: string): void {
  const now = Date.now()
  // Only `wasRecentNetworkUpdate` used to delete, and it is reached only when
  // that note is edited externally on disk — so without this the map grew one
  // entry per note ever received from the network, for the whole session.
  if (now - networkUpdatesSweptAt >= CONCURRENT_EDIT_WINDOW_MS) {
    networkUpdatesSweptAt = now
    sweepExpired(lastNetworkUpdateMs, CONCURRENT_EDIT_WINDOW_MS, now)
  }
  lastNetworkUpdateMs.set(noteId, now)
}

export function wasRecentNetworkUpdate(noteId: string): boolean {
  const ts = lastNetworkUpdateMs.get(noteId)
  if (!ts) return false
  if (Date.now() - ts >= CONCURRENT_EDIT_WINDOW_MS) {
    lastNetworkUpdateMs.delete(noteId)
    return false
  }
  return true
}

export function networkUpdateCount(): number {
  return lastNetworkUpdateMs.size
}

export function resetNetworkUpdateState(): void {
  lastNetworkUpdateMs.clear()
  networkUpdatesSweptAt = 0
}
