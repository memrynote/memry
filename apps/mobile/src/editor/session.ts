import { buildClientHeaderValue, type SeamHttpContext } from '@memry/sync-client/pull'
import { AttachmentTransfer } from '../adapters/attachments'
import { createMobileHttpClient } from '../adapters/http-client'
import { mobileAppVersion } from '../adapters/runtime'
import { openVaultDb, type VaultDb } from '../db/index'
import { withVaultTransaction } from '../db/tx'
import { getOrCreateDeviceId, getVaultKey } from '../lib/secure-store'
import { loadPushSigningKeypair, loadSession, refreshSession } from '../sync/auth-client'
import { DeviceKeyDirectory } from '../sync/device-keys'
import { OutboxDrain, OutboxStore } from '../sync/outbox'
import { createMobilePushCryptoProvider } from '../sync/push-crypto'
import { syncBaseUrl } from '../sync/server-config'
import { createLogger } from '../lib/logger'
import { EditorDocManager, type DocHalves, type DocStore } from './doc-manager'

/**
 * Everything the write path needs, assembled once per vault (US2).
 *
 * The pull engine (`MobileSyncEngine`) and this session share the vault DB but
 * not their queues: pull owns the record cursor and CRDT watermarks, this owns
 * the outbox and the open docs. Keeping them apart is what lets an edit be
 * durable while a pull is mid-flight.
 */

const log = createLogger('EditorSession')

const LOCAL_PREFIX = 'local.'

/**
 * The doc store over the two CRDT namespaces.
 *
 * Server rows sit under the bare doc id with the SERVER's sequence numbers;
 * local rows sit under `local.<docId>` with their own. Mixing them would let a
 * local append take a sequence a later server row also claims, and
 * `ON CONFLICT DO NOTHING` would then drop one of them silently.
 */
export function createVaultDocStore(db: VaultDb): DocStore {
  const localId = (docId: string) => `${LOCAL_PREFIX}${docId}`

  const loadHalf = async (key: string): Promise<DocHalves> => {
    const snap = await db.getFirstAsync<{ snapshot: Uint8Array; last_seq: number }>(
      'SELECT snapshot, last_seq FROM yjs_snapshots WHERE doc_id = ?',
      [key]
    )
    const rows = await db.getAllAsync<{ seq: number; update_blob: Uint8Array }>(
      'SELECT seq, update_blob FROM yjs_updates WHERE doc_id = ? ORDER BY seq ASC',
      [key]
    )
    return {
      snapshot: snap ? new Uint8Array(snap.snapshot) : null,
      updates: rows.map((r) => new Uint8Array(r.update_blob)),
      lastSeq: rows.length > 0 ? rows[rows.length - 1].seq : (snap?.last_seq ?? 0)
    }
  }

  return {
    loadServerHalf: (docId) => loadHalf(docId),
    loadLocalHalf: (docId) => loadHalf(localId(docId)),

    async loadServerUpdatesSince(docId, sinceSeq) {
      // The snapshot is checked too: the pull path folds updates into one and
      // DELETES the rows it folded, so an updates-only read would come back
      // empty and the open doc would keep showing a stale body.
      const snap = await db.getFirstAsync<{ snapshot: Uint8Array; last_seq: number }>(
        'SELECT snapshot, last_seq FROM yjs_snapshots WHERE doc_id = ? AND last_seq > ?',
        [docId, sinceSeq]
      )
      const rows = await db.getAllAsync<{ seq: number; update_blob: Uint8Array }>(
        'SELECT seq, update_blob FROM yjs_updates WHERE doc_id = ? AND seq > ? ORDER BY seq ASC',
        [docId, sinceSeq]
      )
      return {
        snapshot: snap ? new Uint8Array(snap.snapshot) : null,
        snapshotSeq: snap?.last_seq ?? 0,
        updates: rows.map((r) => ({ seq: r.seq, update: new Uint8Array(r.update_blob) }))
      }
    },

    async appendLocalUpdate(docId, update) {
      const row = await db.getFirstAsync<{ max_seq: number | null }>(
        'SELECT MAX(seq) AS max_seq FROM yjs_updates WHERE doc_id = ?',
        [localId(docId)]
      )
      await db.runAsync(
        'INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?, ?, ?, ?)',
        [localId(docId), (row?.max_seq ?? 0) + 1, update, Date.now()]
      )
    },

    /**
     * The persist + ack pair, in ONE transaction.
     *
     * SQLite in WAL mode is durable at commit, so this is what makes the
     * durability rule unbreakable rather than merely well-ordered: an app kill
     * can leave both rows or neither, never an update that is saved locally
     * and that nothing will ever push.
     */
    withCommit<T>(fn: () => Promise<T>): Promise<T> {
      return withVaultTransaction(db, fn)
    },

    async compactLocal(docId, snapshot) {
      await withVaultTransaction(db, async () => {
        // The fold point is read here, inside the transaction, rather than
        // taken from the caller: the caller only knows how many updates it has
        // seen, and a COUNT used as a SEQUENCE prunes nothing after the first
        // fold. Nothing can be appended in between because guest updates are
        // persisted strictly one at a time.
        const row = await db.getFirstAsync<{ max_seq: number | null }>(
          'SELECT MAX(seq) AS max_seq FROM yjs_updates WHERE doc_id = ?',
          [localId(docId)]
        )
        const folded = row?.max_seq ?? 0
        await db.runAsync(
          `INSERT INTO yjs_snapshots (doc_id, snapshot, last_seq, compacted_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(doc_id) DO UPDATE SET snapshot = excluded.snapshot, last_seq = excluded.last_seq, compacted_at = excluded.compacted_at`,
          [localId(docId), snapshot, folded, Date.now()]
        )
        // The snapshot is the whole doc state, so every folded row is now
        // redundant; leaving them would make an actively-edited note open
        // slower every day.
        await db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ? AND seq <= ?', [
          localId(docId),
          folded
        ])
      })
    }
  }
}

/**
 * Drop a note's LOCAL CRDT rows.
 *
 * The pull path clears the bare-doc-id namespace when a tombstone arrives, but
 * it has never heard of `local.<docId>` — so without this a deleted note's
 * locally-originated updates sit in the DB forever.
 */
export async function deleteLocalCrdt(db: VaultDb, docId: string): Promise<void> {
  await withVaultTransaction(db, async () => {
    await db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ?', [`${LOCAL_PREFIX}${docId}`])
    await db.runAsync('DELETE FROM yjs_snapshots WHERE doc_id = ?', [`${LOCAL_PREFIX}${docId}`])
  })
}

/**
 * Sweep local CRDT rows belonging to notes that are already tombstoned.
 *
 * A delete can arrive from another device while this one is offline, and the
 * pull applier only knows about the server namespace — so the local half of a
 * remotely-deleted note would otherwise never be reclaimed.
 */
export async function sweepDeletedLocalCrdt(db: VaultDb): Promise<number> {
  // Updates AND snapshots: compaction deletes every row it folds, so a note
  // that was compacted before being deleted elsewhere has no update rows left
  // and a join over those alone would leak its snapshot forever.
  const rows = await db.getAllAsync<{ doc_id: string }>(
    `SELECT doc_id FROM (
       SELECT DISTINCT doc_id FROM yjs_updates WHERE doc_id LIKE '${LOCAL_PREFIX}%'
       UNION
       SELECT doc_id FROM yjs_snapshots WHERE doc_id LIKE '${LOCAL_PREFIX}%'
     ) local
     JOIN sync_items s ON s.id = SUBSTR(local.doc_id, ${LOCAL_PREFIX.length + 1})
     WHERE s.deleted_at IS NOT NULL`
  )
  for (const row of rows) {
    await db.runAsync('DELETE FROM yjs_updates WHERE doc_id = ?', [row.doc_id])
    await db.runAsync('DELETE FROM yjs_snapshots WHERE doc_id = ?', [row.doc_id])
  }
  return rows.length
}

export interface EditorSession {
  vaultId: string
  db: VaultDb
  /** Stable id this device signs with; every note operation clocks against it. */
  deviceId: string
  outbox: OutboxStore
  docs: EditorDocManager
  drain: OutboxDrain
  attachments: AttachmentTransfer
  /** Push everything queued; safe to call on every foreground/background edge. */
  flush(): Promise<void>
  /**
   * Drop the cached vault key and signing key.
   *
   * `closeEditorSession` removes the session from the registry, but a screen
   * that already holds one keeps working — including encrypting and pushing —
   * unless the secrets themselves are cleared. `refreshSecrets` only re-reads
   * values that are already falsy, so nulling them here is what makes a lock
   * take effect for a session that is already in someone's hands.
   */
  lock(): void
}

const sessions = new Map<string, Promise<EditorSession>>()

export function getEditorSession(vaultId: string): Promise<EditorSession> {
  let pending = sessions.get(vaultId)
  if (!pending) {
    pending = build(vaultId)
    sessions.set(vaultId, pending)
    pending.catch(() => sessions.delete(vaultId))
  }
  return pending
}

export function closeEditorSession(vaultId: string): void {
  const pending = sessions.get(vaultId)
  if (!pending) return
  sessions.delete(vaultId)
  // `lock()`, not just `closeAll()`: removing the session from the registry
  // does nothing for the copy a screen is already holding, which would keep
  // encrypting and pushing with the key it cached at build time.
  void pending.then((session) => session.lock()).catch(() => {})
}

async function build(vaultId: string): Promise<EditorSession> {
  const db = await openVaultDb(vaultId)

  // A delete can arrive from another device while this one is offline, and the
  // pull applier only clears the SERVER namespace — so the local half of a
  // remotely-deleted note is reclaimed here, once, on the way in.
  try {
    const swept = await sweepDeletedLocalCrdt(db)
    if (swept > 0) log.info('Reclaimed local CRDT rows for deleted notes', { docs: swept })
  } catch (err) {
    // Housekeeping must never stop a session from opening.
    log.warn('Local CRDT sweep failed', {
      error: err instanceof Error ? err.message : String(err)
    })
  }

  const outbox = new OutboxStore(db)
  const docs = new EditorDocManager(createVaultDocStore(db), outbox)

  const http = createMobileHttpClient(syncBaseUrl())
  const clientHeaderValue = buildClientHeaderValue('ios', mobileAppVersion())
  const deviceId = await getOrCreateDeviceId()

  // Cached, but re-read whenever the cache is EMPTY. A session built by the
  // background task while the device was still locked would otherwise hold
  // `null` for the rest of the process and silently never push again — the
  // failure mode is an outbox that fills up with no error anywhere.
  let accessToken = (await loadSession())?.accessToken ?? ''
  let vaultKey = await getVaultKey(vaultId)
  let keypair = await loadPushSigningKeypair()
  /** Set by `lock()`; stops the re-read below from silently unlocking. */
  let locked = false

  const refreshSecrets = async (): Promise<void> => {
    if (locked) return
    if (!vaultKey) vaultKey = await getVaultKey(vaultId)
    if (!keypair) keypair = await loadPushSigningKeypair()
    if (!accessToken) accessToken = (await loadSession())?.accessToken ?? ''
  }

  let online = true
  http.onOnlineChanged((next) => {
    online = next
  })

  const httpCtx = (): SeamHttpContext => ({
    http,
    accessToken: () => accessToken,
    vaultId,
    clientHeaderValue
  })

  const crypto = createMobilePushCryptoProvider()

  const drain = new OutboxDrain({
    store: outbox,
    httpCtx,
    crypto,
    vaultKey: () => vaultKey,
    signingSecretKey: () => keypair?.privateKey ?? null,
    deviceId: () => deviceId,
    isOnline: () => online,
    // The escape hatch for an update too large to send incrementally. The doc
    // manager is the only thing that can produce a full state, and it is right
    // here, so the drain never has to give up on a huge paste.
    encodeDocSnapshot: async (docId) => {
      try {
        return (await docs.openDoc(docId)).encodeState()
      } catch {
        return null
      }
    }
  })

  // One directory for the whole session: the attachment manifest check and any
  // later signature check ask the same cache rather than each fetching the
  // device list for themselves.
  const deviceKeys = new DeviceKeyDirectory(httpCtx)

  const attachments = new AttachmentTransfer({
    db,
    http,
    crypto,
    vaultId,
    accessToken: () => accessToken,
    clientHeaderValue,
    vaultKey: () => vaultKey,
    signing: () => (keypair ? { secretKey: keypair.privateKey, deviceId } : null),
    resolveDeviceKey: (id) => deviceKeys.resolve(id),
    isMetered: () => http.isMetered()
  })

  return {
    vaultId,
    db,
    deviceId,
    outbox,
    docs,
    drain,
    attachments,
    lock() {
      // The REFERENCES are dropped immediately, so nothing new can encrypt
      // with them. The buffers are zeroed only once the running drain has
      // settled: `OutboxDrain` captured those same arrays when the pass
      // started, and wiping them mid-pass makes the remaining chunks encrypt
      // with an all-zero key. CRDT updates are not signature-checked
      // server-side, so that blob is ACCEPTED, its queue row is completed, and
      // the edit is undecryptable on every device forever.
      const oldVaultKey = vaultKey
      const oldKeypair = keypair
      vaultKey = null
      keypair = null
      accessToken = ''
      locked = true
      docs.closeAll()

      void drain
        .drain()
        .catch(() => undefined)
        .then(() => {
          oldVaultKey?.fill(0)
          oldKeypair?.privateKey.fill(0)
        })
    },

    async flush() {
      await refreshSecrets()
      const result = await drain.drain()
      // One retry after a token refresh: an expired access token is the single
      // most common reason a first drain of the day fails, and it is fixable
      // without waiting out a backoff the user would experience as lost work.
      if (result.failed > 0 && !result.parked) {
        const fresh = await refreshSession()
        if (fresh) {
          accessToken = fresh
          // Only the rows that just failed: the rest of the queue keeps the
          // backoff it earned, or one refresh would disable it table-wide.
          if (result.failedIds.length > 0) await outbox.clearBackoff(result.failedIds)
          await drain.drain()
        }
      }
    }
  }
}
