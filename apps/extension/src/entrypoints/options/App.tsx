import { useEffect, useState } from 'react'
import type { ConnectionState, PairResponse, StatusResponse } from '@/lib/messages'

const PORT_KEY = 'memry:capture-port'

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

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 bg-background p-6 font-sans text-foreground">
      <h1 className="text-lg font-semibold">Memry Web Clipper</h1>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Pairing</h2>
        <p className="text-[13px] text-text-secondary">Status: {connection}</p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onPair}
            className="rounded bg-primary px-3 py-1.5 text-[13px] text-primary-foreground disabled:opacity-50"
          >
            Re-pair
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onRotate}
            className="rounded border border-border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            Rotate token
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onUnpair}
            className="rounded border border-border px-3 py-1.5 text-[13px] disabled:opacity-50"
          >
            Unpair
          </button>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Port override</h2>
        <p className="text-[13px] text-text-secondary">
          Leave blank to auto-detect (ports 7849–7856).
        </p>
        <div className="flex gap-2">
          <input
            value={port}
            onChange={(e) => setPort(e.target.value)}
            inputMode="numeric"
            placeholder="auto"
            className="w-24 rounded border border-border bg-surface px-2 py-1 text-[13px]"
          />
          <button
            type="button"
            onClick={onSavePort}
            className="rounded border border-border px-3 py-1.5 text-[13px]"
          >
            Save
          </button>
        </div>
      </section>
    </div>
  )
}
