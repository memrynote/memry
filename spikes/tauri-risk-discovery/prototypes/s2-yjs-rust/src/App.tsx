// S2 Prototype B — Shadow Y.Doc + yrs authoritative in Rust
//
// Renderer owns a "shadow" Y.Doc purely so y-prosemirror can bind to BlockNote.
// Authority is yrs in Rust. Each local edit is pushed via invoke('apply_update'),
// Rust-originated echoes are received via the 'crdt-update' Tauri event and
// re-applied with origin='rust' to skip the send-back loop.

import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

const NOTE_ID = 'proto-b-test-note'

interface CrdtUpdatePayload {
  note_id: string
  bytes: number[]
}

function App() {
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const awarenessRef = useRef<Awareness>(new Awareness(ydocRef.current))
  const fragment = ydocRef.current.getXmlFragment('blocknote')

  const editor = useCreateBlockNote({
    collaboration: {
      provider: { awareness: awarenessRef.current } as any,
      fragment,
      user: { name: 'spike-user', color: '#654321' }
    }
  })

  const [updateCount, setUpdateCount] = useState(0)
  const [echoSkipped, setEchoSkipped] = useState(0)
  const [lastStateVectorBytes, setLastStateVectorBytes] = useState(0)
  const [lastError, setLastError] = useState('')

  useEffect(() => {
    const ydoc = ydocRef.current
    const handler = async (update: Uint8Array, origin: unknown) => {
      if (origin === 'rust') {
        setEchoSkipped((c) => c + 1)
        return
      }
      try {
        const sv = await invoke<number[]>('apply_update', {
          noteId: NOTE_ID,
          updateBytes: Array.from(update)
        })
        setUpdateCount((c) => c + 1)
        setLastStateVectorBytes(sv.length)
      } catch (e) {
        setLastError(String(e))
      }
    }
    ydoc.on('update', handler)
    return () => {
      ydoc.off('update', handler)
    }
  }, [])

  useEffect(() => {
    const unlisten = listen<CrdtUpdatePayload>('crdt-update', (event) => {
      if (event.payload.note_id !== NOTE_ID) return
      const bytes = new Uint8Array(event.payload.bytes)
      Y.applyUpdate(ydocRef.current, bytes, 'rust')
    })
    return () => {
      unlisten.then((fn) => fn())
    }
  }, [])

  useEffect(() => {
    invoke<number[]>('get_snapshot', { noteId: NOTE_ID })
      .then((snap) => {
        if (snap && snap.length > 0) {
          Y.applyUpdate(ydocRef.current, new Uint8Array(snap), 'rust')
        }
      })
      .catch((e) => setLastError(String(e)))
  }, [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div
        style={{
          padding: 8,
          display: 'flex',
          gap: 16,
          borderBottom: '1px solid #ccc',
          fontSize: 12
        }}
      >
        <strong>Prototype B (yrs in Rust)</strong>
        <span data-testid="updates-sent">Updates sent to Rust: {updateCount}</span>
        <span data-testid="echo-skipped">Echo updates skipped: {echoSkipped}</span>
        <span data-testid="last-sv-bytes">Last SV bytes: {lastStateVectorBytes}</span>
        {lastError && <span style={{ color: 'red' }}>ERR: {lastError}</span>}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
    </div>
  )
}

export default App
