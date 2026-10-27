import { useEffect } from 'react'
import { commands, events } from '../../../generated/bindings'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { subscribeToEvent } from '@/services/tauri-event'

const log = createLogger('FlushOnQuit')

export function useFlushOnQuit(): void {
  useEffect(() => {
    const unsubscribe = subscribeToEvent(events.flushRequestedEvent, ({ requestId }) => {
      log.info('flush requested by main process')
      void flushAllPendingSaves()
        .catch((error: unknown) => log.error('flush failed, answering anyway', error))
        // Answered even after a failure: main waits on this reply and would only time out.
        .then(() => commands.flushDone(requestId))
        .then(() => log.info('flush complete, main notified'))
        .catch((error: unknown) => log.warn('could not notify main of the flush', error))
    })

    const handleBeforeUnload = (): void => {
      if (hasPendingSaves()) {
        log.info('beforeunload: flushing pending saves')
        void flushAllPendingSaves()
      }
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      unsubscribe()
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])
}
