/**
 * Lets the tabs commands open a group's new-tab menu. Each tab group mounts its
 * own menu inside its tab strip, so `tabs.newTab` cannot own the open state; it
 * asks the menu of the active group instead. It is the one way into that
 * per-group open state, not a second route to the command: only `tabs.newTab` calls it.
 */

const openers = new Map<string, () => void>()

/** Called by a mounted new-tab menu. Returns the cleanup. */
export function registerNewTabMenu(groupId: string, open: () => void): () => void {
  openers.set(groupId, open)
  return () => {
    // The strip swaps its menu between two slots as it overflows: a late cleanup
    // of the old one must not drop the new one.
    if (openers.get(groupId) === open) openers.delete(groupId)
  }
}

export function openNewTabMenu(groupId: string): void {
  openers.get(groupId)?.()
}
