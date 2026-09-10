import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { EditorDocManager, type DocHalves, type DocStore, type OutboxSink } from '../doc-manager'

/**
 * `applyFromHost` (#2100): the host's own persisted write.
 *
 * Same rule `applyFromGuest` is pinned by — DURABLE FIRST — asserted the only
 * way it can be: by refusing the commit and proving the in-memory doc did not
 * move. A doc advanced past a failed commit is a divergence with no symptom
 * until the next open, which is exactly the class of bug a green suite hides.
 */

interface Harness {
  store: DocStore
  outbox: OutboxSink
  calls: string[]
  persisted: Uint8Array[]
  queued: Uint8Array[]
}

function harness(opts: { appendThrows?: boolean } = {}): Harness {
  const empty: DocHalves = { snapshot: null, updates: [], lastSeq: 0 }
  const calls: string[] = []
  const persisted: Uint8Array[] = []
  const queued: Uint8Array[] = []

  return {
    calls,
    persisted,
    queued,
    store: {
      loadServerHalf: async () => empty,
      loadLocalHalf: async () => empty,
      loadServerUpdatesSince: async () => ({ snapshot: null, snapshotSeq: 0, updates: [] }),
      appendLocalUpdate: async (_docId, update) => {
        if (opts.appendThrows) {
          calls.push('append:throw')
          throw new Error('disk full')
        }
        calls.push('append')
        persisted.push(update)
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

describe('OpenDoc.applyFromHost', () => {
  it('persists once, then advances the doc', async () => {
    const rig = harness()
    const open = await new EditorDocManager(rig.store, rig.outbox).openDoc('note-1')

    await open.applyFromHost((draft) => {
      draft.getXmlFragment('prosemirror').push([new Y.XmlElement('blockGroup')])
    })

    expect(rig.calls).toEqual(['append', 'enqueue'])
    expect(rig.persisted).toHaveLength(1)
    expect(open.doc.getXmlFragment('prosemirror').length).toBe(1)
    expect(open.isEmpty()).toBe(false)
  })

  it('leaves the doc and the outbox untouched when the commit fails', async () => {
    const rig = harness({ appendThrows: true })
    const open = await new EditorDocManager(rig.store, rig.outbox).openDoc('note-1')

    await expect(
      open.applyFromHost((draft) => {
        draft.getXmlFragment('prosemirror').push([new Y.XmlElement('blockGroup')])
      })
    ).rejects.toThrow('disk full')

    // The whole point: a write the device did not keep must not be visible to
    // anything that reads the doc afterwards.
    expect(open.isEmpty()).toBe(true)
    expect(rig.queued).toHaveLength(0)
  })

  it('fans an applied write out to BOTH listener sets', async () => {
    const rig = harness()
    const open = await new EditorDocManager(rig.store, rig.outbox).openDoc('note-1')
    const local: Uint8Array[] = []
    const remote: Uint8Array[] = []
    open.onLocalUpdate((update) => local.push(update))
    open.onRemoteUpdate((update) => remote.push(update))

    await open.applyFromHost((draft) => {
      draft.getXmlFragment('prosemirror').push([new Y.XmlElement('blockGroup')])
    })

    // The WebView has never seen these bytes (remote set), and the screen has
    // to count them as work in flight (local set).
    expect(remote).toHaveLength(1)
    expect(local).toHaveLength(1)
  })

  it('commits nothing for a mutation that changes nothing', async () => {
    const rig = harness()
    const open = await new EditorDocManager(rig.store, rig.outbox).openDoc('note-1')

    await open.applyFromHost(() => {})

    expect(rig.calls).toEqual([])
    expect(rig.queued).toHaveLength(0)
  })

  it('refuses to write a document that is not writable', async () => {
    const rig = harness()
    const open = await new EditorDocManager(rig.store, rig.outbox).openDoc('note-1')
    open.setWritable(false)

    await expect(
      open.applyFromHost((draft) => {
        draft.getXmlFragment('prosemirror').push([new Y.XmlElement('blockGroup')])
      })
    ).rejects.toThrow('not writable')
    expect(rig.calls).toEqual([])
  })
})
