import { describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { EditorDocManager, type DocHalves, type DocStore, type OutboxSink } from '../doc-manager'

/**
 * The durability rule (T062): a WebView-originated update is committed to
 * SQLite BEFORE it is acked into the outbox pipeline, and a doc is only
 * complete when BOTH halves — server rows and local rows — have been replayed.
 *
 * These are the two invariants an app kill can expose, so they are asserted
 * against an ordering log rather than against "it eventually appears".
 */

interface Recorder {
  store: DocStore
  outbox: OutboxSink
  calls: string[]
  local: Uint8Array[]
  queued: Uint8Array[]
}

function recorder(
  server: DocHalves = { snapshot: null, updates: [], lastSeq: 0 },
  local: DocHalves = { snapshot: null, updates: [], lastSeq: 0 },
  opts: { appendDelayMs?: number; appendThrows?: boolean } = {}
): Recorder {
  const calls: string[] = []
  const localWrites: Uint8Array[] = []
  const queued: Uint8Array[] = []

  return {
    calls,
    local: localWrites,
    queued,
    store: {
      loadServerHalf: async () => server,
      loadLocalHalf: async () => local,
      loadServerUpdatesSince: async () => [],
      appendLocalUpdate: async (_docId, update) => {
        if (opts.appendDelayMs) await new Promise((r) => setTimeout(r, opts.appendDelayMs))
        if (opts.appendThrows) {
          calls.push('append:throw')
          throw new Error('disk full')
        }
        calls.push('append')
        localWrites.push(update)
      }
    },
    outbox: {
      enqueueCrdtUpdate: async (_docId, update) => {
        calls.push('enqueue')
        queued.push(update)
      }
    }
  }
}

/** A real Yjs update, so the test never passes on a byte string Yjs rejects. */
function makeUpdate(text: string): Uint8Array {
  const doc = new Y.Doc()
  doc.getText('t').insert(0, text)
  return Y.encodeStateAsUpdate(doc)
}

describe('EditorDocManager durability', () => {
  it('commits to SQLite before acking into the outbox', async () => {
    const rec = recorder(undefined, undefined, { appendDelayMs: 5 })
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    await open.applyFromGuest(makeUpdate('hello'))

    expect(rec.calls).toEqual(['append', 'enqueue'])
  })

  it('does not ack an update the store refused', async () => {
    const rec = recorder(undefined, undefined, { appendThrows: true })
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    await expect(open.applyFromGuest(makeUpdate('hello'))).rejects.toThrow('disk full')

    // An update the server was told about but the device did not keep is worse
    // than a lost keystroke: it is a divergence nothing can repair.
    expect(rec.calls).toEqual(['append:throw'])
    expect(rec.queued).toHaveLength(0)
  })

  it('replays BOTH halves — server rows and local rows — on open', async () => {
    const serverDoc = new Y.Doc()
    serverDoc.getText('body').insert(0, 'from-desktop ')
    const localDoc = new Y.Doc()
    localDoc.getText('body').insert(0, 'from-mobile ')

    const rec = recorder(
      { snapshot: null, updates: [Y.encodeStateAsUpdate(serverDoc)], lastSeq: 1 },
      { snapshot: null, updates: [Y.encodeStateAsUpdate(localDoc)], lastSeq: 1 }
    )
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    const merged = new Y.Doc()
    Y.applyUpdate(merged, open.encodeState())
    const text = merged.getText('body').toString()
    expect(text).toContain('from-desktop')
    expect(text).toContain('from-mobile')
  })

  it('survives WebView process death: a re-open replays what was persisted', async () => {
    const rec = recorder()
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    const update = makeUpdate('typed while the WebView was alive')
    await open.applyFromGuest(update)

    // iOS reclaims the WebView and the doc is dropped with it. What comes back
    // is whatever SQLite kept — which is exactly what `append` was given.
    await manager.closeDoc('note-1')
    expect(manager.isOpen('note-1')).toBe(false)

    const reopened = new EditorDocManager(
      {
        ...rec.store,
        loadLocalHalf: async () => ({
          snapshot: null,
          updates: rec.local,
          lastSeq: rec.local.length
        })
      },
      rec.outbox
    )
    const recovered = await reopened.openDoc('note-1')

    const check = new Y.Doc()
    Y.applyUpdate(check, recovered.encodeState())
    expect(check.getText('t').toString()).toBe('typed while the WebView was alive')
  })

  it('never re-queues an update that arrived from sync', async () => {
    const rec = recorder()
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    open.applyFromRemote(makeUpdate('from another device'))

    // Echoing pulled updates back into the outbox would re-upload the entire
    // note body on every open, for every note.
    expect(rec.calls).toEqual([])
  })

  it('routes guest updates to the local listeners and remote updates to the remote ones', async () => {
    const rec = recorder()
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    const local = vi.fn()
    const remote = vi.fn()
    open.onLocalUpdate(local)
    open.onRemoteUpdate(remote)

    await open.applyFromGuest(makeUpdate('a'))
    expect(local).toHaveBeenCalledTimes(1)
    expect(remote).not.toHaveBeenCalled()

    open.applyFromRemote(makeUpdate('b'))
    expect(remote).toHaveBeenCalledTimes(1)
    expect(local).toHaveBeenCalledTimes(1)
  })

  it('pulls in server rows written after the doc was loaded', async () => {
    const rec = recorder()
    const arriving: { seq: number; update: Uint8Array }[] = []
    const manager = new EditorDocManager(
      {
        ...rec.store,
        loadServerUpdatesSince: async (_id, since) => arriving.filter((r) => r.seq > since)
      },
      rec.outbox
    )
    const open = await manager.openDoc('note-1')

    // A desktop edit lands in SQLite between opens. Docs are cached for the
    // process lifetime, so without an explicit refresh it stays invisible in
    // the editor that is showing this note — and stays invisible after
    // navigating away and back.
    arriving.push({ seq: 1, update: makeUpdate('typed on the desktop') })
    expect(await open.refreshFromServer()).toBe(1)

    const check = new Y.Doc()
    Y.applyUpdate(check, open.encodeState())
    expect(check.getText('t').toString()).toBe('typed on the desktop')

    // The watermark advanced, so a second refresh is not a re-apply.
    expect(await open.refreshFromServer()).toBe(0)
  })

  it('refreshes a CACHED doc on re-open', async () => {
    const rec = recorder()
    const arriving: { seq: number; update: Uint8Array }[] = []
    const manager = new EditorDocManager(
      {
        ...rec.store,
        loadServerUpdatesSince: async (_id, since) => arriving.filter((r) => r.seq > since)
      },
      rec.outbox
    )
    await manager.openDoc('note-1')

    arriving.push({ seq: 1, update: makeUpdate('arrived while away') })
    const reopened = await manager.openDoc('note-1')

    const check = new Y.Doc()
    Y.applyUpdate(check, reopened.encodeState())
    expect(check.getText('t').toString()).toBe('arrived while away')
  })

  it('reports emptiness from the editor fragment, not from the update count', async () => {
    const rec = recorder()
    const manager = new EditorDocManager(rec.store, rec.outbox)
    const open = await manager.openDoc('note-1')

    // `isEmpty` gates the markdown seed, so it has to mean "no editor content"
    // rather than "no Yjs data" — a doc can hold metadata and still be blank.
    expect(open.isEmpty()).toBe(true)

    const seeded = new Y.Doc()
    seeded.getXmlFragment('prosemirror').insert(0, [new Y.XmlElement('paragraph')])
    open.applyFromRemote(Y.encodeStateAsUpdate(seeded))
    expect(open.isEmpty()).toBe(false)
  })

  it('reuses an open doc rather than re-reading SQLite per WebView re-create', async () => {
    const rec = recorder()
    const loadServerHalf = vi.fn(rec.store.loadServerHalf)
    const manager = new EditorDocManager({ ...rec.store, loadServerHalf }, rec.outbox)

    const first = await manager.openDoc('note-1')
    const second = await manager.openDoc('note-1')

    expect(second).toBe(first)
    expect(loadServerHalf).toHaveBeenCalledTimes(1)
  })
})
