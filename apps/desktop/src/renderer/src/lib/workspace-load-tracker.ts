/**
 * Reads the workspace makes outside TanStack Query (per-vault settings loaded
 * straight over IPC, note positions, bookmarks).
 *
 * The sidebar pager keeps a snapshot over a freshly switched-to vault until its
 * list has loaded. `queryClient.isFetching()` alone misses these reads, so the
 * cover lifted while sort modes and section order were still at their defaults
 * and the list visibly reordered a moment later. Tracked here, the pager can
 * wait for them too.
 *
 * Module-level: hidden (kept) workspaces run no effects, so what is in flight
 * belongs to the visible one.
 */

let pending = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Count `load` as in flight until it settles. The returned promise settles
 * with it; a rejection still reaches the caller.
 */
export function trackWorkspaceLoad<T>(load: T | PromiseLike<T>): Promise<T> {
  const promise = Promise.resolve(load)
  pending += 1
  notify()
  const done = (): void => {
    pending -= 1
    notify()
  }
  promise.then(done, done)
  return promise
}

export function pendingWorkspaceLoads(): number {
  return pending
}

export function subscribeWorkspaceLoads(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only reset. */
export function resetWorkspaceLoads(): void {
  pending = 0
}
