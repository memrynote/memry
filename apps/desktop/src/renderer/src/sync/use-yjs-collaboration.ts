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
type ActiveYjsCollaborationState = YjsCollaborationState & { noteId: string | null }
const EMPTY_ACTIVE_STATE: ActiveYjsCollaborationState = { noteId: null, ...DISABLED_STATE }

export function useYjsCollaboration(
  options: UseYjsCollaborationOptions
): UseYjsCollaborationReturn {
  const { noteId, enabled = true } = options
  const [activeState, setActiveState] = useState<ActiveYjsCollaborationState>(EMPTY_ACTIVE_STATE)
  const isRemoteUpdateRef = useRef(false)

  useEffect(() => {
    if (!noteId || !enabled) {
      return
    }

    let cancelled = false

    const doc = new Y.Doc({ guid: noteId })

    doc.on('beforeTransaction', (tr: Y.Transaction) => {
      if (tr.origin === 'remote' || tr.origin === 'ipc-provider') {
        isRemoteUpdateRef.current = true
      }
    })
    doc.on('afterTransaction', () => {
      isRemoteUpdateRef.current = false
    })

    const provider = new YjsIpcProvider({ noteId, doc })

    provider
      .connect()
      .then(() => {
        if (cancelled) return
        const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
        setActiveState({ noteId, fragment, provider, isReady: true })
        log.debug('Collaboration ready', { noteId })
      })
      .catch((err) => {
        if (cancelled) return
        log.error('Failed to connect collaboration', err)
        provider.destroy()
        doc.destroy()
        isRemoteUpdateRef.current = false
        setActiveState({ noteId, fragment: null, provider: null, isReady: false })
      })

    return () => {
      cancelled = true
      provider.destroy()
      doc.destroy()
      isRemoteUpdateRef.current = false
    }
  }, [noteId, enabled])

  const state =
    !noteId ||
    !enabled ||
    activeState.noteId !== noteId ||
    !activeState.provider?.isSynced
      ? DISABLED_STATE
      : {
          fragment: activeState.fragment,
          provider: activeState.provider,
          isReady: activeState.isReady
        }

  return { ...state, isRemoteUpdateRef }
}
