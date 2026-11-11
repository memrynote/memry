import { useEffect, useState } from 'react'
import { createLogger } from '@/lib/logger'
import { subscribeToEvent } from '@/services/tauri-event'
import { commands, events } from '../../../generated/bindings'

const log = createLogger('DatabaseReadOnly')

/**
 * Whether the vault's database opened read-only on this device, so nothing typed could be saved
 * (#4190). For a surface with no note yet, such as an empty journal day (#4268): a bound editor
 * hears it from its own open (`database-read-only`), an unbound one has nobody to tell it.
 *
 * Asked at mount and again on each editor ready event, since the vault's open can finish after
 * the surface mounts. An unanswered ask leaves it writable: the refused save then shows its
 * own error.
 */
export function useDatabaseReadOnly(): boolean {
  const [readOnly, setReadOnly] = useState(false)

  useEffect(() => {
    let cancelled = false
    const ask = async (): Promise<void> => {
      try {
        const health = await commands.crdtGetHealth()
        if (!cancelled) setReadOnly(!health.persistent)
      } catch (error) {
        log.warn('Could not read CRDT persistence health', error)
      }
    }
    const stop = subscribeToEvent(
      events.crdtProviderReadyEvent,
      () => void ask(),
      () => void ask()
    )
    return () => {
      cancelled = true
      stop()
    }
  }, [])

  return readOnly
}
