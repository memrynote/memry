import { useEffect } from 'react'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'
import { createLogger } from '@/lib/logger'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'

const log = createLogger('FlushOnQuit')

export function useFlushOnQuit(): void {
  useEffect(() => {
    const unsubscribe = subscribeEvent<void>('flush-requested', () => {
      log.info('flush requested by main process')
      void flushAllPendingSaves().then(() => {
        log.info('flush complete, notifying main')
        void invoke('notify_flush_done')
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
