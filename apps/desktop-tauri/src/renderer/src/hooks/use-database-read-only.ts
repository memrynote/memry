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
 * own error. Only the newest ask's answer counts, so a late answer about an earlier open never
 * overwrites a newer one, and a closed vault forgets its answer until the next open (#4271).
 */
export function useDatabaseReadOnly(): boolean {
  const [readOnly, setReadOnly] = useState(false)

  useEffect(() => {
    let generation = 0
    const ask = async (): Promise<void> => {
      const asked = ++generation
      try {
        const health = await commands.crdtGetHealth()
        if (asked === generation) setReadOnly(!health.persistent)
      } catch (error) {
        log.warn('Could not read CRDT persistence health', error)
      }
    }
    const stopReady = subscribeToEvent(
      events.crdtProviderReadyEvent,
      () => void ask(),
      () => void ask()
    )
    const stopReset = subscribeToEvent(events.crdtProviderResetEvent, () => {
      generation++
      setReadOnly(false)
    })
    return () => {
      generation++
      stopReady()
      stopReset()
    }
  }, [])

  return readOnly
}
