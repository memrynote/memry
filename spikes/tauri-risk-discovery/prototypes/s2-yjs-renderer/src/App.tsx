// S2 Prototype A — Renderer-owned Y.Doc
//
// Y.Doc lives in renderer. y-prosemirror binds it to BlockNote. Every Y.Doc
// update is pushed to Rust via invoke('append_crdt_update'). Snapshots saved
// via invoke('save_crdt_snapshot'), reloaded on mount via 'load_crdt_snapshot'.
//
// Rust side is pure persistence (see src-tauri/src/lib.rs).

import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import * as Y from 'yjs'
import { Awareness } from 'y-protocols/awareness'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'

const NOTE_ID = 'proto-a-test-note'

function App() {
  const ydocRef = useRef<Y.Doc>(new Y.Doc())
  const awarenessRef = useRef<Awareness>(new Awareness(ydocRef.current))
  const fragment = ydocRef.current.getXmlFragment('blocknote')

  const editor = useCreateBlockNote({
    collaboration: {
      provider: { awareness: awarenessRef.current } as any,
      fragment,
      user: { name: 'spike-user', color: '#123456' }
    }
  })

  const [updateCount, setUpdateCount] = useState(0)
  const [lastError, setLastError] = useState<string>('')

  useEffect(() => {
    const ydoc = ydocRef.current
    const handler = (update: Uint8Array, origin: unknown) => {
      if (origin === 'rust') return
      invoke('append_crdt_update', {
        noteId: NOTE_ID,
        bytes: Array.from(update)
      })
        .then(() => setUpdateCount((c) => c + 1))
        .catch((e) => setLastError(String(e)))
    }
    ydoc.on('update', handler)
    return () => {
      ydoc.off('update', handler)
    }
  }, [])

  useEffect(() => {
    invoke<number[] | null>('load_crdt_snapshot', { noteId: NOTE_ID })
      .then((snap) => {
        if (snap && snap.length > 0) {
          Y.applyUpdate(ydocRef.current, new Uint8Array(snap), 'rust')
        }
      })
      .catch((e) => setLastError(String(e)))
  }, [])

  const saveSnapshot = useCallback(async () => {
    const snap = Y.encodeStateAsUpdate(ydocRef.current)
    try {
      await invoke('save_crdt_snapshot', {
        noteId: NOTE_ID,
        bytes: Array.from(snap)
      })
    } catch (e) {
      setLastError(String(e))
    }
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
        <strong>Prototype A (renderer Y.Doc)</strong>
        <button onClick={saveSnapshot}>Save Snapshot</button>
        <span>Updates persisted to Rust: {updateCount}</span>
        {lastError && <span style={{ color: 'red' }}>ERR: {lastError}</span>}
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
    </div>
  )
}

export default App
