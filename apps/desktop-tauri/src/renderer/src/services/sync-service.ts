import { events, type SyncedItem } from '../../../generated/bindings'
import { subscribeToEvent, subscribeToEvents } from './tauri-event'

/** How long a subscriber gathers pulled pages before it hears them, from the first one. */
const COALESCE_MS = 150

/**
 * The records sync pulled, of `types` or of every type: one call per 150 ms of pages, each
 * record once with its last operation. Main sends one event per committed page, and a pull of
 * many pages would otherwise refetch once per page. Notes and journals never arrive here: their
 * events come from the vault (`onNoteUpdated`, the journal events).
 *
 * `onListening` runs once the events reach this page. A page main sends before then reaches
 * nobody and names no record, so a subscriber that reads what the records change reads it all
 * again there (`subscribeToEvents`).
 */
export function onSyncedRecords(
  types: readonly string[] | 'all',
  callback: (items: SyncedItem[]) => void,
  onListening?: () => void
): () => void {
  let pending = new Map<string, SyncedItem>()
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    timer = null
    const items = [...pending.values()]
    pending = new Map()
    callback(items)
  }
  const stop = subscribeToEvent(
    events.syncItemSyncedEvent,
    ({ items }) => {
      for (const item of items) {
        if (types !== 'all' && !types.includes(item.type)) continue
        const key = `${item.type}\u0000${item.itemId}`
        pending.delete(key)
        pending.set(key, item)
      }
      if (pending.size > 0 && timer === null) timer = setTimeout(flush, COALESCE_MS)
    },
    onListening
  )
  return () => {
    stop()
    if (timer !== null) clearTimeout(timer)
  }
}

/**
 * A domain's own event and the records of `types` sync pulled, as one subscription. Electron's
 * item handlers sent the domain's events when they applied a pulled record; here main sends
 * only the pulled page, so the domain's subscription hears it through `onSynced`.
 * `onListening` runs once both reach this page.
 */
export function withSyncedRecords(
  subscribeLocal: (onListening: () => void) => () => void,
  types: readonly string[],
  onSynced: (items: SyncedItem[]) => void,
  onListening?: () => void
): () => void {
  return subscribeToEvents([subscribeLocal, (live) => onSyncedRecords(types, onSynced, live)], () =>
    onListening?.()
  )
}
