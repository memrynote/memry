import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { BRIDGE_PROTOCOL_VERSION, type GuestMsg } from '@memry/contracts/webview-bridge'
import { bytesToBase64 } from '../../lib/base64'
import type { OpenDoc } from '../doc-manager'
import { EditorHostController, type HostDoc } from '../editor-host-controller'

/**
 * The WebView now outlives every note it shows (#2030), so three things that
 * used to be answered by a component's own lifetime have to be answered here:
 * which note the guest is holding, which note a guest message belongs to, and
 * where a guest edit is written. All three fail SILENTLY when they are wrong.
 * The third is the one that destroys data.
 */

interface FakeDoc {
  openDoc: OpenDoc
  applied: string[]
  failNext: boolean
}

function fakeOpenDoc(docId: string): FakeDoc {
  const doc = new Y.Doc()
  const applied: string[] = []
  const fake: FakeDoc = {
    applied,
    failNext: false,
    openDoc: {
      docId,
      doc,
      encodeState: () => Y.encodeStateAsUpdate(doc),
      isEmpty: () => true,
      applyFromGuest: async (update) => {
        if (fake.failNext) {
          fake.failNext = false
          throw new Error('persist failed')
        }
        applied.push(bytesToBase64(update))
      },
      applyFromRemote: () => {},
      refreshFromServer: async () => 0,
      onLocalUpdate: () => () => {},
      onRemoteUpdate: () => () => {},
      inUse: () => false,
      close: () => doc.destroy()
    }
  }
  return fake
}

interface Attachment extends HostDoc {
  mounts: number
  received: GuestMsg[]
}

function attachment(fake: FakeDoc): Attachment {
  const entry: Attachment = {
    doc: fake.openDoc,
    mounts: 0,
    received: [],
    onGuestMsg: (msg) => entry.received.push(msg),
    mount: () => {
      entry.mounts += 1
    }
  }
  return entry
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

const painted = (docId: string): GuestMsg => ({ type: 'painted', docId })

const edit = (docId: string, text: string): GuestMsg => {
  const source = new Y.Doc()
  source.getText('t').insert(0, text)
  return { type: 'y-update', docId, updatesB64: [bytesToBase64(Y.encodeStateAsUpdate(source))] }
}

/** A controller with a live transport and a guest that has finished its handshake. */
function warmHost(): { host: EditorHostController; sent: string[] } {
  const host = new EditorHostController('rn-test')
  const transport = collector()
  host.webViewLoaded(transport.inject)
  host.bridge.receive(guestEnvelope(1, [READY]))
  return { host, sent: transport.sent }
}

/** The persist chain is async; one turn is enough for a resolved `applyFromGuest`. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('EditorHostController write path', () => {
  it('lands a guest edit in the note it names even after that note has detached', async () => {
    const { host } = warmHost()
    const a = fakeOpenDoc('note-a')
    const detachA = host.attach(attachment(a))
    let seq = 2
    host.bridge.receive(guestEnvelope(seq++, [painted('note-a')]))

    // The reader taps back. The screen goes, the guest does not, and the
    // keystrokes it had batched are still on their way.
    detachA()

    host.bridge.receive(guestEnvelope(seq++, [edit('note-a', 'typed just before leaving')]))
    await settle()

    // Dropping this destroys the edit outright: the guest replica that held it
    // is torn down at the next `mountDoc`, so nothing anywhere would still have
    // it. `applyFromGuest` is what makes it durable.
    expect(a.applied).toHaveLength(1)
  })

  it('lands a guest edit for A while B is the note on screen', async () => {
    const { host } = warmHost()
    const a = fakeOpenDoc('note-a')
    const b = fakeOpenDoc('note-b')
    const entryA = attachment(a)
    const entryB = attachment(b)
    host.attach(entryA)
    host.setFocused(entryA, true)
    host.attach(entryB)
    host.setFocused(entryA, false)
    host.setFocused(entryB, true)

    // An update naming A can only BE A's own edit: the guest installs that
    // listener in `mountDoc('A')` and drops it in `teardown()`.
    host.bridge.receive(guestEnvelope(2, [edit('note-a', 'A tail'), edit('note-b', 'B typing')]))
    await settle()

    expect(a.applied).toHaveLength(1)
    expect(b.applied).toHaveLength(1)
  })

  it('still routes the messages that belong to the note on screen', () => {
    const { host } = warmHost()
    const entryA = attachment(fakeOpenDoc('note-a'))
    const entryB = attachment(fakeOpenDoc('note-b'))
    host.attach(entryA)
    host.setFocused(entryA, true)
    host.attach(entryB)
    host.setFocused(entryA, false)
    host.setFocused(entryB, true)

    // Unaddressed, so it belongs to whatever is mounted, and nothing else.
    host.bridge.receive(guestEnvelope(2, [{ type: 'nav', target: 'Somewhere' }]))

    expect(entryA.received).toEqual([])
    expect(entryB.received).toEqual([{ type: 'nav', target: 'Somewhere' }])
  })

  it('drops an update for a note nothing ever opened, rather than inventing a doc', async () => {
    const { host } = warmHost()
    const a = fakeOpenDoc('note-a')
    host.attach(attachment(a))

    host.bridge.receive(guestEnvelope(2, [edit('note-ghost', 'nowhere to go')]))
    await settle()

    expect(a.applied).toEqual([])
  })
})

describe('EditorHostController mounting', () => {
  it('mounts the focused route, not the one that finished loading last', () => {
    const { host } = warmHost()
    const x = attachment(fakeOpenDoc('note-x'))
    const y = attachment(fakeOpenDoc('note-y'))

    // Two quick taps. Y is on top, but a note withholds its editor until its
    // own open chain resolves, so Y can attach FIRST.
    host.setFocused(y, true)
    host.attach(y)
    host.attach(x)

    // Attach order would have put X on the guest while the reader is on Y,
    // leaving Y's screen with nothing and nothing to re-sync it.
    expect(host.getState().mountedDocId).toBe('note-y')
    expect(y.mounts).toBe(1)
    expect(x.mounts).toBe(0)
  })

  it('mounts a doc that attached before the guest was ready', () => {
    const host = new EditorHostController('rn-test')
    const a = attachment(fakeOpenDoc('note-a'))
    host.setFocused(a, true)
    host.attach(a)

    expect(a.mounts).toBe(0)
    expect(host.getState()).toMatchObject({ guest: 'cold', mountedDocId: 'note-a' })

    host.webViewLoaded(collector().inject)
    host.bridge.receive(guestEnvelope(1, [READY]))

    expect(a.mounts).toBe(1)
    expect(host.getState().guest).toBe('ready')
  })

  it('keeps the guest when a doc detaches', () => {
    const { host, sent } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    const b = attachment(fakeOpenDoc('note-b'))
    const detachA = host.attach(a)
    host.setFocused(b, true)
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
    const a = attachment(fakeOpenDoc('note-a'))
    const b = attachment(fakeOpenDoc('note-b'))
    host.setFocused(a, true)
    host.attach(a)
    host.setFocused(a, false)
    host.setFocused(b, true)
    const detachB = host.attach(b)

    expect(a.mounts).toBe(1)

    // `router.back()`: B goes, and A is the focused route again.
    detachB()
    host.setFocused(a, true)

    expect(a.mounts).toBe(2)
    expect(host.getState().mountedDocId).toBe('note-a')
  })

  it('leaves the mounted note alone when a doc below it detaches', () => {
    const { host } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    const b = attachment(fakeOpenDoc('note-b'))
    const detachA = host.attach(a)
    host.setFocused(b, true)
    host.attach(b)

    detachA()

    // Re-sending `doc-load` here would tear the guest's editor down and
    // rebuild it under the caret, for a screen that did not change.
    expect(b.mounts).toBe(1)
  })

  it('takes the keyboard back from the note it is about to replace', () => {
    const { host, sent } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    host.setFocused(a, true)
    host.attach(a)

    // Neither `opacity: 0` nor `pointerEvents: none` stops iOS delivering
    // keystrokes to a contenteditable that still holds focus.
    expect(sent.some((js) => js.includes('blur'))).toBe(true)
  })

  it('keeps the send sequence monotonic across a doc switch', () => {
    const { host, sent } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    a.mount = () => {
      host.bridge.send({ type: 'doc-load', docId: 'note-a', stateB64: '' })
      host.bridge.flush()
    }
    const b = attachment(fakeOpenDoc('note-b'))
    b.mount = () => {
      host.bridge.send({ type: 'doc-load', docId: 'note-b', stateB64: '' })
      host.bridge.flush()
    }

    host.setFocused(a, true)
    host.attach(a)
    host.setFocused(a, false)
    host.setFocused(b, true)
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
    const a = attachment(fakeOpenDoc('note-a'))
    host.setFocused(a, true)
    host.attach(a)
    expect(a.mounts).toBe(1)

    host.guestCrashed()
    expect(host.getState().guest).toBe('cold')
    expect(host.getState().instance).toBe(1)

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
})

describe('EditorHostController visibility', () => {
  it('stays hidden until the guest confirms it has painted the mounted note', () => {
    const { host } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    host.setFocused(a, true)
    host.attach(a)
    host.setLayout(a, { frame: { top: 200, height: 500 }, onScreen: true })

    // The host has handed the note over, but the guest is still showing
    // whatever it had. Revealing now uncovers the previous note's body sitting
    // in this note's frame.
    expect(host.getState().visible).toBe(false)

    host.bridge.receive(guestEnvelope(2, [painted('note-a')]))
    expect(host.getState().visible).toBe(true)
  })

  it('stays hidden while the route has not settled where it belongs', () => {
    const { host } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    host.setFocused(a, true)
    host.attach(a)
    host.bridge.receive(guestEnvelope(2, [painted('note-a')]))

    // Mid-push, or mid-swipe-back. The host does not slide with the stack, so
    // a body drawn now floats over the screen moving under it.
    host.setLayout(a, { frame: { top: 200, height: 500 }, onScreen: false })
    expect(host.getState().visible).toBe(false)

    host.setLayout(a, { frame: { top: 200, height: 500 }, onScreen: true })
    expect(host.getState().visible).toBe(true)
  })

  it("reports the mounted note's own frame and never the previous note's", () => {
    const { host } = warmHost()
    const a = attachment(fakeOpenDoc('note-a'))
    const b = attachment(fakeOpenDoc('note-b'))
    host.setFocused(a, true)
    host.attach(a)
    host.setLayout(a, { frame: { top: 200, height: 500 }, onScreen: true })
    expect(host.getState().frame).toEqual({ top: 200, height: 500 })

    host.setFocused(a, false)
    host.setFocused(b, true)
    host.attach(b)
    // B has not measured itself yet. Reusing A's frame would draw B's body
    // where A's happened to sit.
    expect(host.getState().frame).toBeNull()
    expect(host.getState().visible).toBe(false)
  })
})
