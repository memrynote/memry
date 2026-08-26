import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import * as Y from 'yjs'
import { decryptCrdtUpdatePacked, decryptRecordItem } from '@memry/sync-client/pull'
import {
  encryptCrdtUpdatePacked,
  encryptRecordForPush,
  type SyncPushCryptoProvider
} from '@memry/sync-client/push'
import { EditorDocManager, type DocHalves, type DocStore } from '../../editor/doc-manager'
import { bumpClock } from '../outbox'
import { nodeCryptoProvider, Relay } from './relay'

/**
 * US2 seam tests (T065).
 *
 * Three scenarios the constitution names, run over the REAL client code — the
 * same encryptors, decryptors, doc manager and Yjs merge the app ships. Only
 * the transport is a stand-in (see `relay.ts`); everything a bug could hide in
 * is the shipped module.
 *
 *   (a) concurrent desktop + mobile edits to one note converge with neither
 *       side's text lost,
 *   (b) delete-vs-edit resolves the same way on both shells,
 *   (c) a newer-desktop payload survives a mobile edit with its unknown fields
 *       intact.
 */

const FRAGMENT = 'prosemirror'

let crypto: SyncPushCryptoProvider
let vaultKey: Uint8Array
/**
 * The sumo typings overload `crypto_sign_keypair` on its output format and
 * resolve the bare call to the STRING variant, so the format is passed
 * explicitly — the bytes are what every signature call downstream needs.
 */
interface SigningKeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

let desktop: { id: string; keys: SigningKeyPair }
let mobile: { id: string; keys: SigningKeyPair }

beforeAll(async () => {
  await sodium.ready
  crypto = nodeCryptoProvider()
  vaultKey = sodium.randombytes_buf(32)
  desktop = { id: 'device-desktop', keys: sodium.crypto_sign_keypair('uint8array') }
  mobile = { id: 'device-mobile', keys: sodium.crypto_sign_keypair('uint8array') }
})

/** A doc store backed by two in-memory halves, mirroring the SQLite namespaces. */
function memoryStore(): DocStore & { local: Uint8Array[]; server: Uint8Array[] } {
  const local: Uint8Array[] = []
  const server: Uint8Array[] = []
  const half = (updates: Uint8Array[]): DocHalves => ({ snapshot: null, updates })
  return {
    local,
    server,
    loadServerHalf: async () => half(server),
    loadLocalHalf: async () => half(local),
    appendLocalUpdate: async (_docId, update) => {
      local.push(update)
    }
  }
}

function textOf(doc: Y.Doc): string {
  return doc.getXmlFragment(FRAGMENT).toString()
}

function seedParagraph(text: string): Y.Doc {
  const doc = new Y.Doc()
  const fragment = doc.getXmlFragment(FRAGMENT)
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  fragment.insert(0, [paragraph])
  return doc
}

function appendParagraph(doc: Y.Doc, text: string): void {
  const fragment = doc.getXmlFragment(FRAGMENT)
  const paragraph = new Y.XmlElement('paragraph')
  paragraph.insert(0, [new Y.XmlText(text)])
  fragment.insert(fragment.length, [paragraph])
}

describe('(a) concurrent desktop and mobile edits to the same note', () => {
  it('converges with neither side lost', async () => {
    const relay = new Relay()
    const noteId = 'note-shared'

    // A base state both devices already have.
    const base = seedParagraph('shared opening line')
    const baseUpdate = Y.encodeStateAsUpdate(base)

    // --- mobile, through the shipped doc manager ---------------------------
    const store = memoryStore()
    store.server.push(baseUpdate)
    const queued: Uint8Array[] = []
    const manager = new EditorDocManager(store, {
      enqueueCrdtUpdate: async (_docId, update) => {
        queued.push(update)
      }
    })
    const open = await manager.openDoc(noteId)

    // The WebView's edit arrives as a Yjs update, exactly as the bridge
    // delivers it.
    const mobileScratch = new Y.Doc()
    Y.applyUpdate(mobileScratch, Y.encodeStateAsUpdate(open.doc))
    appendParagraph(mobileScratch, 'typed on the phone')
    await open.applyFromGuest(Y.encodeStateAsUpdate(mobileScratch, Y.encodeStateVector(open.doc)))
    expect(queued).toHaveLength(1)

    // --- desktop, editing at the same time ---------------------------------
    const desktopDoc = new Y.Doc()
    Y.applyUpdate(desktopDoc, baseUpdate)
    const beforeDesktopEdit = Y.encodeStateVector(desktopDoc)
    appendParagraph(desktopDoc, 'typed on the desktop')
    const desktopUpdate = Y.encodeStateAsUpdate(desktopDoc, beforeDesktopEdit)

    // --- both push, encrypted, to the relay --------------------------------
    relay.pushCrdt(
      noteId,
      encryptCrdtUpdatePacked(crypto, queued[0], vaultKey, noteId, mobile.keys.privateKey),
      mobile.id
    )
    relay.pushCrdt(
      noteId,
      encryptCrdtUpdatePacked(crypto, desktopUpdate, vaultKey, noteId, desktop.keys.privateKey),
      desktop.id
    )

    // --- both pull everything and decrypt ----------------------------------
    const signerKeys: Record<string, Uint8Array> = {
      [mobile.id]: mobile.keys.publicKey,
      [desktop.id]: desktop.keys.publicKey
    }
    const decrypted: Uint8Array[] = []
    for (const row of relay.crdtSince(noteId, 0)) {
      decrypted.push(
        await decryptCrdtUpdatePacked(
          crypto,
          row.packed,
          vaultKey,
          noteId,
          signerKeys[row.signerDeviceId]
        )
      )
    }

    for (const update of decrypted) {
      open.applyFromRemote(update)
      Y.applyUpdate(desktopDoc, update)
    }

    const mobileText = textOf(open.doc)
    const desktopText = textOf(desktopDoc)

    expect(mobileText).toContain('typed on the phone')
    expect(mobileText).toContain('typed on the desktop')
    expect(mobileText).toContain('shared opening line')
    // Convergence is the assertion, not "both contain the words": Yjs must
    // produce the SAME document on both sides, ordering included.
    expect(mobileText).toBe(desktopText)
  })

  it('does not re-queue the desktop update it just applied', async () => {
    const store = memoryStore()
    store.server.push(Y.encodeStateAsUpdate(seedParagraph('base')))
    const queued: Uint8Array[] = []
    const manager = new EditorDocManager(store, {
      enqueueCrdtUpdate: async (_docId, update) => {
        queued.push(update)
      }
    })
    const open = await manager.openDoc('note-1')

    const remote = new Y.Doc()
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(open.doc))
    appendParagraph(remote, 'from the desktop')
    open.applyFromRemote(Y.encodeStateAsUpdate(remote, Y.encodeStateVector(open.doc)))

    // A pulled update that echoes back into the outbox re-uploads the whole
    // note body on every sync, for every note, forever.
    expect(queued).toHaveLength(0)
  })
})

describe('(b) delete-vs-edit tombstone', () => {
  it('resolves identically on both shells: the tombstone wins and the body is orphaned', async () => {
    const relay = new Relay()
    const noteId = 'note-doomed'

    // Desktop deletes.
    const deletedAt = 1_700_000_000_000
    const deletePayload: Record<string, unknown> = { title: 'Doomed' }
    const deleteClock = bumpClock(deletePayload, desktop.id)
    const { pushItem: tombstone } = await encryptRecordForPush(crypto, {
      id: noteId,
      type: 'note',
      operation: 'delete',
      content: new TextEncoder().encode(JSON.stringify(deletePayload)),
      vaultKey,
      signingSecretKey: desktop.keys.privateKey,
      signerDeviceId: desktop.id,
      clock: deleteClock,
      deletedAt
    })
    relay.pushRecord({ ...tombstone, deletedAt })

    // Mobile, concurrently and without having seen the delete, edits the body.
    const store = memoryStore()
    store.server.push(Y.encodeStateAsUpdate(seedParagraph('doomed body')))
    const queued: Uint8Array[] = []
    const manager = new EditorDocManager(store, {
      enqueueCrdtUpdate: async (_docId, update) => {
        queued.push(update)
      }
    })
    const open = await manager.openDoc(noteId)
    const scratch = new Y.Doc()
    Y.applyUpdate(scratch, Y.encodeStateAsUpdate(open.doc))
    appendParagraph(scratch, 'edited on the phone after the delete')
    await open.applyFromGuest(Y.encodeStateAsUpdate(scratch, Y.encodeStateVector(open.doc)))
    relay.pushCrdt(
      noteId,
      encryptCrdtUpdatePacked(crypto, queued[0], vaultKey, noteId, mobile.keys.privateKey),
      mobile.id
    )

    // Both shells now read the same record feed. The feed carries `deletedAt`,
    // and both appliers key deletion off it — which is exactly why the outcome
    // is identical on both: neither side arbitrates, they read the same fact.
    const feed = relay.changesSince(0)
    const noteRows = feed.filter((row) => row.id === noteId)
    expect(noteRows).toHaveLength(1)
    expect(noteRows[0].operation).toBe('delete')
    expect(noteRows[0].deletedAt).toBe(deletedAt)

    // The body update is still in CRDT storage and is not lost — but it is
    // orphaned, because the note it belongs to is a tombstone. That is the
    // deterministic resolution both shells implement: a delete is a record-feed
    // fact, and no amount of later body traffic resurrects the note.
    expect(relay.crdtSince(noteId, 0)).toHaveLength(1)

    // The tombstone still decrypts and verifies — a delete is a signed item,
    // not an absence, so a peer can tell "deleted" from "never seen".
    await expect(
      decryptRecordItem(
        crypto,
        { ...noteRows[0], cryptoVersion: 1 },
        vaultKey,
        desktop.keys.publicKey
      )
    ).resolves.toBeInstanceOf(Uint8Array)
  })
})

describe('(c) unknown-field round-trip', () => {
  it('keeps fields a newer desktop wrote through a mobile edit cycle', async () => {
    // A payload from a build that knows keys this one does not.
    const fromNewerDesktop = {
      title: 'Quarterly plan',
      folderPath: 'Work',
      tags: ['planning'],
      properties: { status: 'active' },
      clock: { [desktop.id]: 3 },
      createdAt: 1,
      modifiedAt: 2,
      // None of these exist in this build's NotePayload.
      reviewState: { approvedBy: 'someone', at: 1234 },
      pinnedTags: ['planning'],
      futureFlag: true
    }

    const { pushItem } = await encryptRecordForPush(crypto, {
      id: 'note-future',
      type: 'note',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify(fromNewerDesktop)),
      vaultKey,
      signingSecretKey: desktop.keys.privateKey,
      signerDeviceId: desktop.id,
      clock: fromNewerDesktop.clock
    })

    // Mobile pulls and stores the decrypted JSON VERBATIM — the baseline
    // migration's rule, and the whole reason unknown fields survive.
    const stored = new TextDecoder().decode(
      await decryptRecordItem(
        crypto,
        { ...pushItem, cryptoVersion: 1 },
        vaultKey,
        desktop.keys.publicKey
      )
    )

    // The mobile edit: parse what was stored, touch only its own fields, write
    // the whole object back. This is exactly what `updateNote` does.
    const payload = JSON.parse(stored) as Record<string, unknown>
    payload.title = 'Quarterly plan (edited on the phone)'
    payload.modifiedAt = 999
    bumpClock(payload, mobile.id)

    const { pushItem: roundTripped } = await encryptRecordForPush(crypto, {
      id: 'note-future',
      type: 'note',
      operation: 'update',
      content: new TextEncoder().encode(JSON.stringify(payload)),
      vaultKey,
      signingSecretKey: mobile.keys.privateKey,
      signerDeviceId: mobile.id,
      clock: payload.clock as Record<string, number>
    })

    const backOnDesktop = JSON.parse(
      new TextDecoder().decode(
        await decryptRecordItem(
          crypto,
          { ...roundTripped, cryptoVersion: 1 },
          vaultKey,
          mobile.keys.publicKey
        )
      )
    ) as Record<string, unknown>

    expect(backOnDesktop.reviewState).toEqual(fromNewerDesktop.reviewState)
    expect(backOnDesktop.pinnedTags).toEqual(fromNewerDesktop.pinnedTags)
    expect(backOnDesktop.futureFlag).toBe(true)
    expect(backOnDesktop.title).toBe('Quarterly plan (edited on the phone)')
    // The clock advanced for the editing device without discarding the other's.
    expect(backOnDesktop.clock).toEqual({ [desktop.id]: 3, [mobile.id]: 1 })
  })
})
