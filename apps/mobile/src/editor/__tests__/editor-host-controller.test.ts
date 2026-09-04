import { describe, expect, it } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION, type GuestMsg } from '@memry/contracts/webview-bridge'
import { EditorHostController, type HostDoc } from '../editor-host-controller'

/**
 * The WebView now outlives every note it shows (#2030), so the two things that
 * used to be answered by a component's own lifetime have to be answered here:
 * which note the guest is holding, and which note a guest message belongs to.
 * Both fail silently when they are wrong — an edit persisted into the wrong
 * note, an editor behind a permanent spinner — so they are asserted rather
 * than reasoned about.
 */

interface FakeDoc extends HostDoc {
  mounts: number
  received: GuestMsg[]
}

function fakeDoc(docId: string): FakeDoc {
  const doc: FakeDoc = {
    docId,
    mounts: 0,
    received: [],
    onGuestMsg: (msg) => doc.received.push(msg),
    mount: () => {
      doc.mounts += 1
    }
  }
  return doc
}

function collector(): { sent: string[]; inject: (js: string) => void } {
  const sent: string[] = []
  return { sent, inject: (js) => sent.push(js) }
}

/**
 * The `seq` of an injected envelope.
 *
 * The transport embeds the envelope JSON inside a JS source string, so the
 * quotes arrive escaped; reading the number out is cheaper and clearer than
 * unwrapping two layers of encoding to get at it.
 */
function seqOf(js: string): number {
  const match = /\\"seq\\":(\d+)/.exec(js)
  if (!match) throw new Error(`no seq in ${js.slice(0, 80)}`)
  return Number(match[1])
}

function guestEnvelope(seq: number, msgs: GuestMsg[]): string {
  return JSON.stringify({ v: BRIDGE_PROTOCOL_VERSION, sid: 'wv-test', seq, msgs })
}

const READY: GuestMsg = { type: 'ready', protocolV: BRIDGE_PROTOCOL_VERSION, schemaV: 'test' }

/** A controller with a live transport and a guest that has finished its handshake. */
function warmHost(): { host: EditorHostController; sent: string[] } {
  const host = new EditorHostController('rn-test')
  const transport = collector()
  host.webViewLoaded(transport.inject)
  host.bridge.receive(guestEnvelope(1, [READY]))
  return { host, sent: transport.sent }
}

describe('EditorHostController', () => {
  it('mounts a doc attached after the handshake', () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')

    host.attach(a)

    expect(a.mounts).toBe(1)
    expect(host.getState()).toMatchObject({ guest: 'ready', mountedDocId: 'note-a' })
  })

  it('mounts a doc that attached before the guest was ready', () => {
    const host = new EditorHostController('rn-test')
    const a = fakeDoc('note-a')
    host.attach(a)

    // Nothing to hand it to yet, but the host already knows which note is on
    // screen — otherwise the handshake would arrive with nowhere to send it.
    expect(a.mounts).toBe(0)
    expect(host.getState()).toMatchObject({ guest: 'cold', mountedDocId: 'note-a' })

    host.webViewLoaded(collector().inject)
    host.bridge.receive(guestEnvelope(1, [READY]))

    expect(a.mounts).toBe(1)
    expect(host.getState().guest).toBe('ready')
  })

  it('mounts B over A and stops routing guest messages to A', () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')
    const b = fakeDoc('note-b')
    host.attach(a)
    host.attach(b)

    expect(b.mounts).toBe(1)
    expect(host.getState().mountedDocId).toBe('note-b')

    host.bridge.receive(
      guestEnvelope(2, [
        { type: 'y-update', docId: 'note-b', updatesB64: ['bbb'] },
        // A's own id, arriving while B is on screen. Delivering it would
        // persist B's typing into A.
        { type: 'y-update', docId: 'note-a', updatesB64: ['aaa'] },
        // Unaddressed, so it belongs to whatever is mounted — which is B.
        { type: 'nav', target: 'Somewhere' }
      ])
    )

    expect(a.received).toEqual([])
    expect(b.received).toEqual([
      { type: 'y-update', docId: 'note-b', updatesB64: ['bbb'] },
      { type: 'nav', target: 'Somewhere' }
    ])
  })

  it('keeps the guest when a doc detaches', () => {
    const { host, sent } = warmHost()
    const a = fakeDoc('note-a')
    const b = fakeDoc('note-b')
    const detachA = host.attach(a)
    host.attach(b)

    detachA()

    // A left the stack under B. Tearing the WebView down here is the 489 ms
    // this host exists to remove, and B is still the note on screen.
    expect(host.getState()).toMatchObject({ guest: 'ready', mountedDocId: 'note-b' })
    expect(b.mounts).toBe(1)

    const before = sent.length
    host.bridge.send({ type: 'exec', cmd: 'flush' })
    host.bridge.flush()
    // The transport is still live: a detach that had dropped it would leave
    // every later message queued against nothing.
    expect(sent.length).toBe(before + 1)
  })

  it('puts the note underneath back on the guest when the top one leaves', () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')
    const b = fakeDoc('note-b')
    host.attach(a)
    const detachB = host.attach(b)

    expect(a.mounts).toBe(1)

    detachB()

    // `router.back()`. A's screen never re-rendered, so nothing but this would
    // ask the guest to show it again — and it is still showing B.
    expect(a.mounts).toBe(2)
    expect(host.getState().mountedDocId).toBe('note-a')

    host.bridge.receive(
      guestEnvelope(2, [{ type: 'y-update', docId: 'note-a', updatesB64: ['x'] }])
    )
    expect(a.received).toHaveLength(1)
    expect(b.received).toEqual([])
  })

  it('leaves the mounted note alone when a doc below it detaches', () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')
    const b = fakeDoc('note-b')
    const detachA = host.attach(a)
    host.attach(b)

    detachA()

    // Re-sending `doc-load` here would tear the guest's editor down and
    // rebuild it under the caret, for a screen that did not change.
    expect(b.mounts).toBe(1)
  })

  it('keeps the send sequence monotonic across a doc switch', () => {
    const { host, sent } = warmHost()
    const a = fakeDoc('note-a')
    a.mount = () => {
      host.bridge.send({ type: 'doc-load', docId: 'note-a', stateB64: '' })
      host.bridge.flush()
    }
    const b = fakeDoc('note-b')
    b.mount = () => {
      host.bridge.send({ type: 'doc-load', docId: 'note-b', stateB64: '' })
      host.bridge.flush()
    }

    host.attach(a)
    host.attach(b)

    const sequences = sent.map(seqOf)

    // One provider for the WebView's lifetime. Re-keying it per note would
    // restart `seq` while the guest's `lastHostSeq` stayed where it was, which
    // `bridge-provider.ts` documents as an infinite resync loop.
    expect(sequences.length).toBeGreaterThanOrEqual(2)
    expect(sequences).toEqual([...sequences].sort((x, y) => x - y))
    expect(new Set(sequences).size).toBe(sequences.length)
  })

  it('replays doc-load for the note on screen after the content process dies', () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')
    host.attach(a)
    expect(a.mounts).toBe(1)

    host.guestCrashed()
    expect(host.getState().guest).toBe('cold')
    expect(host.getState().instance).toBe(1)

    // A new WebView, a new handshake, and the note that was on screen is still
    // the one to show — its RN-side doc was never at risk.
    host.webViewLoaded(collector().inject)
    host.bridge.receive(guestEnvelope(1, [READY]))

    // More than once: a fresh guest restarts its own `seq` at 1, which the
    // provider correctly reads as a gap and answers with a resync, so the
    // handshake's `doc-load` and the resync's overlap. Both carry the same
    // state, and the alternative — a provider re-keyed per WebView — is the
    // infinite resync loop this host exists to avoid.
    expect(a.mounts).toBeGreaterThan(1)
    expect(host.getState()).toMatchObject({ guest: 'ready', mountedDocId: 'note-a' })
  })

  it("reports the mounted note's frame, and nothing while none is mounted", () => {
    const { host } = warmHost()
    const a = fakeDoc('note-a')
    const b = fakeDoc('note-b')
    const detachA = host.attach(a)
    host.setLayout(a, { frame: { top: 200, height: 500 }, visible: true })

    expect(host.getState()).toMatchObject({ frame: { top: 200, height: 500 }, visible: true })

    host.attach(b)
    // B has not measured itself yet. Reusing A's frame would draw B's body
    // where A's happened to sit.
    expect(host.getState().frame).toBeNull()
    expect(host.getState().visible).toBe(false)

    host.setLayout(b, { frame: { top: 260, height: 440 }, visible: true })
    detachA()
    expect(host.getState()).toMatchObject({ frame: { top: 260, height: 440 }, visible: true })
  })
})
