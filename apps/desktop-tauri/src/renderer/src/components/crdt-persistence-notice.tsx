import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { createLogger } from '@/lib/logger'
import { subscribeToEvent } from '@/services/tauri-event'
import { commands, events } from '../../../generated/bindings'

const log = createLogger('CrdtPersistenceNotice')

/**
 * Tell the user, once per launch, when this device cannot save: the vault's
 * database opened read-only, so every note opens read-only and the editor
 * refuses typing (#4190). Told on the first such launch, since nothing typed
 * then could be kept.
 *
 * Electron's notice waited for three in-memory launches and said notes still
 * saved, which held there: only its separate CRDT store failed. In this app the
 * edits, the note rows and the file write-back all go through the database.
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

        announced.current = true
        toast(t('crdt.databaseReadOnlyTitle'), {
          description: t('crdt.databaseReadOnlyBody'),
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
