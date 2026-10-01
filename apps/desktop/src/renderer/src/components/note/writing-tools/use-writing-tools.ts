import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useT } from '@memry/i18n/renderer'
import { isMac } from '@/lib/shortcut-registry'
import { writingToolsService } from '@/services/writing-tools-service'
import { WritingToolsSession, type WritingToolsSnapshot } from './writing-tools-session'

/** The note page's writing tools session and its live snapshot. */
export function useWritingTools(): {
  session: WritingToolsSession
  snapshot: WritingToolsSnapshot
} {
  const { t } = useT('notes')
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  const [session] = useState(
    () =>
      new WritingToolsSession(
        (input) => writingToolsService.generateAssist(input),
        (position, total) => tRef.current('writingTools.alternatives.hint', { position, total }),
        isMac
      )
  )
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot)
  return { session, snapshot }
}
