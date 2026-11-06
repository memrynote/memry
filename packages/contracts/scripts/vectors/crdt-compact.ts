/**
 * Class: local compaction (`crdt-compact.json`), chapter 12 §12.5.4.
 *
 * A document's log in, its compacted local snapshot out. The snapshot is
 * `Y.encodeStateAsUpdate` of the log's replay, the same encode every snapshot
 * push makes (`apps/desktop/src/main/sync/crdt-snapshot-push.ts:90`), never
 * Electron's `compactYDoc` root copy, which §12.5.3 and §12.5.4 retire. The
 * three refusals (nothing local to fold, an update still waiting on one the log
 * lacks, a snapshot no smaller than the local rows it replaces) are the rule of
 * §12.5.4; this generator states them once for the verifier to hold the Rust to.
 *
 * Each case is a load plan in the order chapter 07's loader applies it
 * (`server`, then `localSnapshot`, then `local`), hex v1 updates with pinned
 * client ids so the file is reproducible. `expected.state` is the snapshot, or
 * null for a refusal. A case with a `peer` update also pins that an edit made
 * against the body before the fold merges into the snapshot to the same
 * document as into the unfolded log: `expected.withPeer` is that document.
 *
 * Verified by the Rust `crdt_compact.rs` (crates/memry-core/tests).
 */
import * as Y from 'yjs'

import { meta } from './shared'

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')

const WINDOW = 0x6d656d72
const SERVER = 0x73727672
const PEER = 0x70656572

/** A document whose every committed update is recorded, in order. */
function recorder(clientId: number): { doc: Y.Doc; updates: Uint8Array[] } {
  const doc = new Y.Doc()
  doc.clientID = clientId
  const updates: Uint8Array[] = []
  doc.on('update', (update: Uint8Array) => updates.push(update))
  return { doc, updates }
}

/** Replaces the body with one paragraph of `text`, as a long session's deletes leave it. */
function rewrite(doc: Y.Doc, text: string): void {
  const body = doc.getXmlFragment('prosemirror')
  doc.transact(() => {
    body.delete(0, body.length)
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [new Y.XmlText(text)])
    body.insert(0, [paragraph])
  })
}

function churn(doc: Y.Doc, edits: number): void {
  for (let n = 0; n < edits; n++) rewrite(doc, `revision ${n} `.repeat(16))
}

interface Plan {
  server: Uint8Array[]
  localSnapshot?: Uint8Array
  local: Uint8Array[]
  peer?: Uint8Array
}

function replay(blobs: Uint8Array[]): Y.Doc {
  const doc = new Y.Doc()
  for (const blob of blobs) Y.applyUpdate(doc, blob)
  return doc
}

function blobsOf(plan: Plan): Uint8Array[] {
  return [...plan.server, ...(plan.localSnapshot ? [plan.localSnapshot] : []), ...plan.local]
}

/** §12.5.4: the full-state encode, unless one of the three refusals holds. */
function compacted(plan: Plan): Uint8Array | null {
  if (plan.local.length === 0) return null
  const doc = replay(blobsOf(plan))
  if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null
  const state = Y.encodeStateAsUpdate(doc)
  const replaced = [...(plan.localSnapshot ? [plan.localSnapshot] : []), ...plan.local].reduce(
    (sum, blob) => sum + blob.byteLength,
    0
  )
  return state.byteLength < replaced ? state : null
}

interface Spec {
  name: string
  pins: string
  plan: () => Plan
}

const SPECS: Spec[] = [
  {
    name: 'a churned body',
    pins: 'forty rewrites fold into one paragraph and the delete set',
    plan: () => {
      const window = recorder(WINDOW)
      churn(window.doc, 40)
      return { server: [], local: window.updates }
    }
  },
  {
    name: 'roots this build does not type survive',
    pins: 'markdownSource and a future root, never typed by the reader, are in the snapshot (§12.5.1)',
    plan: () => {
      const window = recorder(WINDOW)
      window.doc.getMap('markdownSource').set('record', { source: '# foreign\n' })
      window.doc.getArray('someFutureRoot').insert(0, ['kept', 7])
      window.doc.getText('anotherFutureText').insert(0, 'also kept')
      churn(window.doc, 30)
      return { server: [], local: window.updates }
    }
  },
  {
    name: 'a server body under local churn',
    pins: 'the snapshot holds the server items too; the server rows stay where they are',
    plan: () => {
      const server = recorder(SERVER)
      server.doc.getMap('meta').set('title', 'From the server')
      server.doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('server text')])
      const window = recorder(WINDOW)
      Y.applyUpdate(window.doc, Y.encodeStateAsUpdate(server.doc))
      window.updates.length = 0
      churn(window.doc, 30)
      return { server: server.updates, local: window.updates }
    }
  },
  {
    name: 'a fold over an earlier fold',
    pins: 'the earlier local snapshot counts among the bytes replaced',
    plan: () => {
      const window = recorder(WINDOW)
      churn(window.doc, 20)
      const localSnapshot = Y.encodeStateAsUpdate(window.doc)
      window.updates.length = 0
      churn(window.doc, 20)
      return { server: [], localSnapshot, local: window.updates }
    }
  },
  {
    name: 'a peer edit made before the fold',
    pins: 'a paragraph typed against a body the later rewrites deleted merges into the snapshot as into the log',
    plan: () => {
      const window = recorder(WINDOW)
      churn(window.doc, 20)
      const peer = recorder(PEER)
      Y.applyUpdate(peer.doc, Y.encodeStateAsUpdate(window.doc))
      peer.updates.length = 0
      const body = peer.doc.getXmlFragment('prosemirror')
      const paragraph = new Y.XmlElement('paragraph')
      paragraph.insert(0, [new Y.XmlText('typed in the other window')])
      body.insert(body.length, [paragraph])
      churn(window.doc, 20)
      return { server: [], local: window.updates, peer: Y.mergeUpdates(peer.updates) }
    }
  },
  {
    name: 'refused: one update',
    pins: 'a snapshot no smaller than the rows it replaces is not written',
    plan: () => {
      const window = recorder(WINDOW)
      window.doc.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('one edit')])
      return { server: [], local: window.updates }
    }
  },
  {
    name: 'refused: nothing local',
    pins: 'server rows alone are the server namespace, which a local fold never takes',
    plan: () => {
      const server = recorder(SERVER)
      churn(server.doc, 20)
      return { server: server.updates, local: [] }
    }
  },
  {
    name: 'refused: a local update waits on one the log lacks',
    pins: 'an update held back for a missing antecedent is not in the encode, so nothing folds',
    plan: () => {
      const window = recorder(WINDOW)
      churn(window.doc, 30)
      // The first update is missing: every later one waits on it.
      return { server: [], local: window.updates.slice(1) }
    }
  }
]

export function buildCrdtCompact(): unknown {
  return {
    meta: meta({
      chapter: 'docs/protocol/12-note-body-format.md §12.5.4',
      loadOrder: 'server, localSnapshot, local'
    }),
    cases: SPECS.map((spec) => {
      const plan = spec.plan()
      const state = compacted(plan)
      const replaced = [...(plan.localSnapshot ? [plan.localSnapshot] : []), ...plan.local]
      return {
        name: spec.name,
        pins: spec.pins,
        input: {
          server: plan.server.map(hex),
          ...(plan.localSnapshot ? { localSnapshot: hex(plan.localSnapshot) } : {}),
          local: plan.local.map(hex),
          ...(plan.peer ? { peer: hex(plan.peer) } : {})
        },
        expected: {
          state: state ? hex(state) : null,
          savedBytes: state
            ? replaced.reduce((sum, blob) => sum + blob.byteLength, 0) - state.byteLength
            : null,
          ...(plan.peer
            ? { withPeer: hex(Y.encodeStateAsUpdate(replay([...blobsOf(plan), plan.peer]))) }
            : {})
        }
      }
    })
  }
}
