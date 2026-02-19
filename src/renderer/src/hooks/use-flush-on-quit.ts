import { useEffect } from 'react'
import { flushAllPendingSaves, hasPendingSaves } from '@/lib/save-registry'

export function useFlushOnQuit(): void {
  useEffect(() => {
    const unsubscribe = window.api.onFlushRequested(() => {
      void flushAllPendingSaves().then(() => window.api.notifyFlushDone())
    })

    const handleBeforeUnload = (): void => {
      if (hasPendingSaves()) {
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
