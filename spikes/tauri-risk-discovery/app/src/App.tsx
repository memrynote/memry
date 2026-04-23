import { useCreateBlockNote } from '@blocknote/react'
import { BlockNoteView } from '@blocknote/shadcn'
import { useCallback, useState } from 'react'
import '@blocknote/core/fonts/inter.css'
import '@blocknote/shadcn/style.css'
import './App.css'

const STORAGE_KEY = 'spike-s1-blocknote-doc'

function App() {
  const editor = useCreateBlockNote({
    initialContent: (() => {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (!saved) return undefined
      try {
        return JSON.parse(saved)
      } catch {
        return undefined
      }
    })()
  })

  const [lastDump, setLastDump] = useState<string>('')

  const save = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(editor.document))
  }, [editor])

  const load = useCallback(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      try {
        const blocks = JSON.parse(saved)
        editor.replaceBlocks(editor.document, blocks)
      } catch (e) {
        console.error('Load failed:', e)
      }
    }
  }, [editor])

  const dumpJson = useCallback(() => {
    const json = JSON.stringify(editor.document, null, 2)
    setLastDump(json)
    console.log('BlockNote dump:', json)
  }, [editor])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ padding: 8, display: 'flex', gap: 8, borderBottom: '1px solid #ccc' }}>
        <button onClick={save}>Save</button>
        <button onClick={load}>Load</button>
        <button onClick={dumpJson}>Dump JSON</button>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        <BlockNoteView editor={editor} />
      </div>
      {lastDump && (
        <pre
          style={{
            maxHeight: 200,
            overflow: 'auto',
            fontSize: 10,
            padding: 8,
            margin: 0,
            borderTop: '1px solid #ccc'
          }}
        >
          {lastDump}
        </pre>
      )}
    </div>
  )
}

export default App
