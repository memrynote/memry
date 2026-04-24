import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { runAllBench } from './bench'
import { getOptionCDb } from './db-option-c'
import './App.css'

const PROTO_NAME = 'S3 Option C — hybrid (rusqlite + plugin-sql)'

function App() {
  const [status, setStatus] = useState<string>('init')
  const [versionRust, setVersionRust] = useState<string>('?')
  const [versionPlugin, setVersionPlugin] = useState<string>('?')
  const [results, setResults] = useState<unknown[]>([])
  const [progress, setProgress] = useState<string>('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const vRust = await invoke<string>('db_version')
        const db = await getOptionCDb()
        const rows = await db.select<Array<{ v: string }>>('SELECT sqlite_version() AS v')
        if (cancelled) return
        setVersionRust(vRust)
        setVersionPlugin(rows[0]?.v ?? 'unknown')
        setStatus('running bench')
        const runs = await runAllBench((m) => {
          if (!cancelled) setProgress(m)
        })
        if (cancelled) return
        setResults(runs)
        setStatus(`done (${runs.length} tests)`)
      } catch (err) {
        if (!cancelled) setStatus(`error: ${String(err)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24, lineHeight: 1.5 }}>
      <h1>{PROTO_NAME}</h1>
      <p>
        Status: <code>{status}</code>
      </p>
      <p>
        Progress: <code>{progress}</code>
      </p>
      <p>
        SQLite (rusqlite): <code>{versionRust}</code>
      </p>
      <p>
        SQLite (plugin-sql): <code>{versionPlugin}</code>
      </p>
      {results.length > 0 && (
        <table style={{ borderCollapse: 'collapse', fontSize: 13, marginTop: 12 }}>
          <thead>
            <tr style={{ background: '#eee' }}>
              <th style={{ padding: '4px 8px', textAlign: 'left' }}>test</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>p50</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>p95</th>
              <th style={{ padding: '4px 8px', textAlign: 'right' }}>n</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const row = r as { test: string; p50: number; p95: number; samples: number[] }
              return (
                <tr key={row.test}>
                  <td style={{ padding: '4px 8px', fontFamily: 'ui-monospace' }}>{row.test}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{row.p50.toFixed(2)}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{row.p95.toFixed(2)}</td>
                  <td style={{ padding: '4px 8px', textAlign: 'right' }}>{row.samples.length}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </div>
  )
}

export default App
