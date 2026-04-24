import { useEffect, useState, type ReactElement } from 'react'

import { invoke } from './lib/ipc/invoke'

interface AppPlaceholderProps {
  initialCommand?: string
}

/**
 * Minimal placeholder shell for M1. Mounts once to prove the renderer
 * bundle boots, Tailwind CSS loads, and the mock IPC pipeline is
 * reachable end-to-end. Replaced by the ported App component in a
 * subsequent phase (renderer utilities + App.tsx port).
 */
export function AppPlaceholder({
  initialCommand = 'notes_list'
}: AppPlaceholderProps): ReactElement {
  const [noteCount, setNoteCount] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    invoke<unknown[]>(initialCommand)
      .then((result) => {
        if (cancelled) return
        setNoteCount(Array.isArray(result) ? result.length : 0)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [initialCommand])

  return (
    <main className="min-h-screen bg-background text-foreground flex flex-col items-center justify-center gap-4 p-8 font-sans">
      <h1 className="text-2xl font-semibold">Memry — M1 Tauri skeleton</h1>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        Renderer bundle booted. Mock IPC pipeline active. Real App component
        lands in the next phase.
      </p>
      {error ? (
        <p data-testid="mock-error" className="text-sm text-red-500">
          Mock IPC error: {error}
        </p>
      ) : noteCount === null ? (
        <p className="text-sm text-muted-foreground">Invoking mock IPC…</p>
      ) : (
        <p data-testid="mock-notes-count" className="text-sm">
          {noteCount} mock notes reachable via invoke(&apos;{initialCommand}&apos;)
        </p>
      )}
    </main>
  )
}
