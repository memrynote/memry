import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_T_FLUSH_MS,
  type GuestMsg
} from '@memry/contracts/webview-bridge'
import { EditorBridgeProvider, type BridgeTransport } from '../bridge-provider'

/**
 * Regression cover for the three ways this bridge can fail SILENTLY — no
 * exception, no log the user sees, just an editor that never loads or never
 * stops reloading. Each of these shipped once.
 */

function collector(): BridgeTransport & { sent: string[] } {
  const sent: string[] = []
  return { sent, send: (envelope) => sent.push(envelope) }
}

function guestEnvelope(seq: number, msgs: GuestMsg[]): string {
  return JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, sid: 'wv-test', seq, msgs })
}

const READY: GuestMsg = { type: 'ready', protocolV: BRIDGE_PROTOCOL_VERSION, schemaV: 'test' }

describe('EditorBridgeProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('delivers what queued up before a transport was attached', () => {
    const provider = new EditorBridgeProvider('rn-test')

    // The guest sends `ready` while its script is still evaluating, which can
    // beat `onLoadEnd`. The answer therefore queues against no transport.
    provider.send({ type: 'doc-load', docId: 'note-1', stateB64: '' })
    provider.flush()

    const transport = collector()
    provider.attach(transport)

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toContain('doc-load')
  })

  it('does not strand a batch whose flush found no transport', () => {
    const provider = new EditorBridgeProvider('rn-test')
    provider.send({ type: 'exec', cmd: 'focus' })
    provider.flush() // no transport yet

    const transport = collector()
    provider.attach(transport)
    // Attaching flushed it; nothing was dropped and no timer was cancelled
    // into a queue that only a later `send()` could revive.
    expect(transport.sent).toHaveLength(1)
  })

  it('keeps the send sequence monotonic across a resync', () => {
    const transport = collector()
    const resyncs: string[] = []
    const provider = new EditorBridgeProvider('rn-test')
    provider.attach(transport)
    provider.onResyncNeeded((reason) => {
      resyncs.push(reason)
      provider.send({ type: 'doc-load', docId: 'note-1', stateB64: '' })
      provider.flush()
    })

    provider.send({ type: 'exec', cmd: 'focus' })
    provider.flush()

    // A gap on the guest's side.
    provider.receive(guestEnvelope(1, [READY]))
    provider.receive(guestEnvelope(5, [READY]))

    expect(resyncs).toHaveLength(1)
    const sequences = transport.sent.map((raw) => (JSON.parse(raw) as { seq: number }).seq)
    // Restarting at 0 would make every following envelope read as a fresh gap
    // on a guest whose `lastHostSeq` has not moved — an infinite resync loop
    // that remounts the editor each round.
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b))
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('still delivers the messages in a gapped envelope', () => {
    const provider = new EditorBridgeProvider('rn-test')
    provider.attach(collector())
    const seen: GuestMsg[] = []
    provider.onGuestMsg((msg) => seen.push(msg))

    provider.receive(guestEnvelope(1, [{ type: 'nav', target: 'A' }]))
    provider.receive(guestEnvelope(7, [READY]))

    // `ready` is exactly what arrives first after iOS reclaims the WebView's
    // content process — dropping the gapped envelope leaves the loading
    // overlay up forever and `onReady` never re-fires.
    expect(seen.map((m) => m.type)).toEqual(['nav', 'ready'])
    expect(provider.getCounters().seqGaps).toBe(1)
  })

  it('batches on the flush interval rather than per message', () => {
    const transport = collector()
    const provider = new EditorBridgeProvider('rn-test')
    provider.attach(transport)

    provider.send({ type: 'y-update', docId: 'n', updatesB64: ['AA'] })
    provider.send({ type: 'y-update', docId: 'n', updatesB64: ['BB'] })
    provider.send({ type: 'y-update', docId: 'n', updatesB64: ['CC'] })
    expect(transport.sent).toHaveLength(0)

    vi.advanceTimersByTime(BRIDGE_T_FLUSH_MS)
    expect(transport.sent).toHaveLength(1)
    expect(provider.getCounters().msgsSent).toBe(3)
  })

  it('ignores a payload that is not a valid envelope instead of throwing', () => {
    const provider = new EditorBridgeProvider('rn-test')
    provider.attach(collector())
    const seen: GuestMsg[] = []
    provider.onGuestMsg((msg) => seen.push(msg))

    expect(() => provider.receive('not json')).not.toThrow()
    expect(() =>
      provider.receive(JSON.stringify({ v: 99, sid: 'x', seq: 1, msgs: [] }))
    ).not.toThrow()
    expect(seen).toHaveLength(0)
  })
})
