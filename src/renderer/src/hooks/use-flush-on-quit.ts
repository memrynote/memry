import { useEffect } from 'react'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'

const log = createLogger('FlushOnQuit')

export function useFlushOnQuit(): void {
  useEffect(() => {
    const unsubscribe = window.api.onFlushRequested(() => {
      log.info('flush requested by main process')
      void flushAllPendingSaves().then(() => {
        log.info('flush complete, notifying main')
        window.api.notifyFlushDone()
      })
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
