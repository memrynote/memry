import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'

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
 * Renders nothing. Mounted next to the app rather than inside it so a partially
 * mocked `window.api` in a component test cannot reach it, and so the query
 * resolves after the app's Toaster is mounted.
 */
export function CrdtPersistenceNotice(): null {
  const { t } = useT('errors')
  const announced = useRef(false)

  useEffect(() => {
    if (announced.current) return
    announced.current = true

    let cancelled = false
    void (async () => {
      try {
        const health = await window.api.syncCrdt.getHealth()
        if (cancelled) return
        if (health.persistent) return
        if (health.inMemorySessions < DEGRADED_SESSION_THRESHOLD) return

        toast(t('crdt.persistenceDegradedTitle'), {
          description: t('crdt.persistenceDegradedBody'),
          duration: 15000
        })
      } catch (error) {
        // A device with no answer here is not a device to nag; the main-process
        // telemetry already carries the failure.
        log.warn('Could not read CRDT persistence health', error)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [t])

  return null
}
