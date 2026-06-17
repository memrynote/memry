import { useEffect, useState, type ReactNode } from 'react'
import type { ConnectionState, PairResponse, StatusResponse } from '@/lib/messages'

const PORT_KEY = 'memry:capture-port'

const STATUS: Record<'unknown' | ConnectionState, { tone: string; label: string }> = {
  unknown: { tone: 'bg-text-tertiary', label: 'Checking…' },
  ready: { tone: 'bg-ready', label: 'Paired and connected' },
  'needs-pairing': { tone: 'bg-ready', label: 'Connected — not yet paired' },
  'app-closed': { tone: 'bg-text-tertiary', label: 'Memry is closed' }
}

function GhostButton({
  children,
  onClick,
  disabled
}: {
  children: ReactNode
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="rounded-md border border-border bg-surface px-3 py-1.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-surface-active hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground/20 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

export default function App() {
  const [connection, setConnection] = useState<'unknown' | ConnectionState>('unknown')
  const [port, setPort] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = () =>
    browser.runtime
      .sendMessage({ type: 'GET_STATUS' })
      .then((r: StatusResponse) => setConnection(r.connection))
      .catch(() => setConnection('app-closed'))

  useEffect(() => {
    void refresh()
    browser.storage.local.get(PORT_KEY).then((r) => {
      const v = r[PORT_KEY]
      if (typeof v === 'number') setPort(String(v))
    })
  }, [])

  const onPair = async () => {
    setBusy(true)
    const r: PairResponse = await browser.runtime.sendMessage({ type: 'PAIR' }).catch(() => ({
      ok: false
    }))
    setBusy(false)
    if (r.ok) void refresh()
  }

  const onUnpair = async () => {
    setBusy(true)
    await browser.runtime.sendMessage({ type: 'REVOKE' }).catch(() => {})
    setBusy(false)
    void refresh()
  }

  const onRotate = async () => {
    setBusy(true)
    try {
      await browser.runtime.sendMessage({ type: 'REVOKE' }).catch(() => {})
      const r: PairResponse = await browser.runtime
        .sendMessage({ type: 'PAIR' })
        .catch(() => ({ ok: false }))
      if (r.ok) void refresh()
    } finally {
      setBusy(false)
    }
  }

  const onSavePort = async () => {
    const n = parseInt(port, 10)
    if (port.trim() === '' || Number.isNaN(n)) {
      await browser.storage.local.remove(PORT_KEY)
    } else {
      await browser.storage.local.set({ [PORT_KEY]: n })
    }
    void refresh()
  }

  const status = STATUS[connection]

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <div className="mx-auto flex max-w-lg flex-col gap-8 px-6 py-10">
        <header className="flex items-center gap-2.5">
          <span
            className="grid size-7 place-items-center rounded-lg bg-brand text-[14px] font-bold leading-none text-white"
            aria-hidden
          >
            M
          </span>
          <div className="flex flex-col">
            <h1 className="text-[15px] font-semibold leading-tight tracking-tight">Web Clipper</h1>
            <p className="text-[12px] text-text-tertiary">Memry browser extension settings</p>
          </div>
        </header>

        <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-strong p-5">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold">Pairing</h2>
            <span className="flex items-center gap-1.5" title={status.label}>
              <span className={`size-1.5 rounded-full ${status.tone}`} aria-hidden />
              <span className="text-[12px] text-text-tertiary">{status.label}</span>
            </span>
          </div>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            Pairing links this browser to your Memry app with a private token. Your first save pairs
            automatically — these controls are here if you need to re-approve or revoke access.
          </p>
          <div className="flex flex-wrap gap-2">
            <GhostButton onClick={onPair} disabled={busy}>
              Re-pair
            </GhostButton>
            <GhostButton onClick={onRotate} disabled={busy}>
              Rotate token
            </GhostButton>
            <GhostButton onClick={onUnpair} disabled={busy}>
              Unpair
            </GhostButton>
          </div>
        </section>

        <section className="flex flex-col gap-4 rounded-xl border border-border bg-surface-strong p-5">
          <h2 className="text-[13px] font-semibold">Port override</h2>
          <p className="text-[13px] leading-relaxed text-text-secondary">
            Leave blank to auto-detect Memry on ports 7849–7856. Only set this if you've changed the
            app's loopback port.
          </p>
          <div className="flex gap-2">
            <input
              value={port}
              onChange={(e) => setPort(e.target.value)}
              inputMode="numeric"
              placeholder="auto"
              className="w-28 rounded-md border border-border bg-background px-3 py-1.5 text-[13px] text-foreground outline-none transition-shadow placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-foreground/20"
            />
            <GhostButton onClick={onSavePort}>Save</GhostButton>
          </div>
        </section>
      </div>
    </div>
  )
}
