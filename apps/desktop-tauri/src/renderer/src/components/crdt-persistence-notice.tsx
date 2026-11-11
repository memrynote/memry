import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { subscribeToEvent } from '@/services/tauri-event'
import { commands, events } from '../../../generated/bindings'

const log = createLogger('CrdtPersistenceNotice')

/**
 * Consecutive in-memory launches before the notice is worth interrupting for.
 *
 * Not 1: a single degraded launch is usually a store that quarantined itself
 * and will be healthy next time, and saying anything then would be noise. Three
 * is a machine that is not recovering on its own.
 */
const DEGRADED_SESSION_THRESHOLD = 3

/**
 * Tell the user, calmly and once per launch, when this device has stopped
 * keeping CRDT state on disk.
 *
 * Until this existed an install could run in memory forever — a whole Windows
 * population did (issue #1583) — with a log line as the only signal. The
 * wording is deliberately not alarming, because nothing the user wrote is at
 * risk: vault markdown is the source of truth and still loads and saves. What
 * is actually lost is durable CRDT state — edit history and the local Yjs state
 * vector that lets an offline device merge cleanly instead of resolving against
 * a from-scratch document.
 *
 * Renders nothing. Mounted beside the open vault's Toaster in App: sonner drops
 * a toast sent before its Toaster mounts, and the loading screen has none.
 *
 * Asked once the window hears the editor's ready event, and again on each ready:
 * the host counts the launch at the vault's open, which may finish after this
 * mounts (#4190).
 */
export function CrdtPersistenceNotice(): null {
  const { t } = useT('errors')
  const announced = useRef(false)

  useEffect(() => {
    let cancelled = false
    const ask = async (): Promise<void> => {
      try {
        const health = await commands.crdtGetHealth()
        if (cancelled || announced.current) return
        if (health.persistent) return
        if (health.inMemorySessions < DEGRADED_SESSION_THRESHOLD) return

        announced.current = true
        toast(t('crdt.persistenceDegradedTitle'), {
          description: t('crdt.persistenceDegradedBody'),
          duration: 15000
        })
      } catch (error) {
        // A device with no answer here is not a device to nag; the main-process
        // telemetry already carries the failure.
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
  }, [t])

  return null
}
