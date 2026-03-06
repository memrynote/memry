import { useState, useEffect, useRef, type RefObject } from 'react'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { YjsIpcProvider } from './yjs-ipc-provider'
import { createLogger } from '@/lib/logger'

const log = createLogger('useYjsCollaboration')

export interface YjsCollaborationState {
  fragment: Y.XmlFragment | null
  provider: YjsIpcProvider | null
  isReady: boolean
}

export interface UseYjsCollaborationOptions {
  noteId: string | undefined
  enabled?: boolean
}

export interface UseYjsCollaborationReturn extends YjsCollaborationState {
  isRemoteUpdateRef: RefObject<boolean>
}

const DISABLED_STATE: YjsCollaborationState = { fragment: null, provider: null, isReady: false }

export function useYjsCollaboration(
  options: UseYjsCollaborationOptions
): UseYjsCollaborationReturn {
  const { noteId, enabled = true } = options
  const [state, setState] = useState<YjsCollaborationState>(DISABLED_STATE)
  const providerRef = useRef<YjsIpcProvider | null>(null)
  const docRef = useRef<Y.Doc | null>(null)
  const isRemoteUpdateRef = useRef(false)

  useEffect(() => {
    if (!noteId || !enabled) {
      setState(DISABLED_STATE)
      return
    }

    let cancelled = false

    const doc = new Y.Doc({ guid: noteId })
    docRef.current = doc

    doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin === 'remote' || tr.origin === 'ipc-provider') {
        isRemoteUpdateRef.current = true
      }
    })
    doc.on('afterTransaction', () => {
      isRemoteUpdateRef.current = false
    })

    const provider = new YjsIpcProvider({ noteId, doc })
    providerRef.current = provider

    provider
      .connect()
      .then(() => {
        if (cancelled) return
        const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
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
      isRemoteUpdateRef.current = false
      setState({ fragment: null, provider: null, isReady: false })
    }
  }, [noteId, enabled])

  return { ...state, isRemoteUpdateRef }
}
