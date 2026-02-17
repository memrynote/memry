import { useState, useEffect, useRef } from 'react'
import * as Y from 'yjs'
import { YjsIpcProvider } from './yjs-ipc-provider'
import { createLogger } from '@/lib/logger'

const log = createLogger('useYjsCollaboration')

export interface YjsCollaborationState {
  fragment: Y.XmlFragment | null
  provider: YjsIpcProvider | null
  isReady: boolean
}

export function useYjsCollaboration(noteId: string | undefined): YjsCollaborationState {
  const [state, setState] = useState<YjsCollaborationState>({
    fragment: null,
    provider: null,
    isReady: false
  })
  const providerRef = useRef<YjsIpcProvider | null>(null)
  const docRef = useRef<Y.Doc | null>(null)

  useEffect(() => {
    if (!noteId) {
      setState({ fragment: null, provider: null, isReady: false })
      return
    }

    let cancelled = false

    const doc = new Y.Doc({ guid: noteId })
    docRef.current = doc

    const provider = new YjsIpcProvider({ noteId, doc })
    providerRef.current = provider

    provider
      .connect()
      .then(() => {
        if (cancelled) return
        const fragment = doc.getXmlFragment('prosemirror')
        setState({ fragment, provider, isReady: true })
        log.debug('Collaboration ready', { noteId })
      })
      .catch((err) => {
        if (cancelled) return
        log.error('Failed to connect collaboration', err)
        setState({ fragment: null, provider: null, isReady: false })
      })

    return () => {
      cancelled = true
      provider.destroy()
      doc.destroy()
      providerRef.current = null
      docRef.current = null
      setState({ fragment: null, provider: null, isReady: false })
    }
  }, [noteId])

  return state
}
