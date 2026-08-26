import { buildClientHeaderValue, type SeamHttpContext } from '@memry/sync-client/pull'
import { AttachmentTransfer } from '../adapters/attachments'
import { createMobileHttpClient } from '../adapters/http-client'
import { mobileAppVersion } from '../adapters/runtime'
import { openVaultDb, type VaultDb } from '../db/index'
import { getDeviceSigningKeypair, getOrCreateDeviceId, getVaultKey } from '../lib/secure-store'
import { loadSession, refreshSession } from '../sync/auth-client'
import { DeviceKeyDirectory } from '../sync/device-keys'
import { OutboxDrain, OutboxStore } from '../sync/outbox'
import { createMobilePushCryptoProvider } from '../sync/push-crypto'
import { syncBaseUrl } from '../sync/server-config'
import { EditorDocManager, type DocHalves, type DocStore } from './doc-manager'

/**
 * Everything the write path needs, assembled once per vault (US2).
 *
 * The pull engine (`MobileSyncEngine`) and this session share the vault DB but
 * not their queues: pull owns the record cursor and CRDT watermarks, this owns
 * the outbox and the open docs. Keeping them apart is what lets an edit be
 * durable while a pull is mid-flight.
 */

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
    const snap = await db.getFirstAsync<{ snapshot: Uint8Array }>(
      'SELECT snapshot FROM yjs_snapshots WHERE doc_id = ?',
      [key]
    )
    const rows = await db.getAllAsync<{ update_blob: Uint8Array }>(
      'SELECT update_blob FROM yjs_updates WHERE doc_id = ? ORDER BY seq ASC',
      [key]
    )
    return {
      snapshot: snap ? new Uint8Array(snap.snapshot) : null,
      updates: rows.map((r) => new Uint8Array(r.update_blob))
    }
  }

  return {
    loadServerHalf: (docId) => loadHalf(docId),
    loadLocalHalf: (docId) => loadHalf(localId(docId)),

    async appendLocalUpdate(docId, update) {
      // One transaction, and it resolves only after commit — SQLite in WAL
      // mode is durable at commit, which is the whole durability guarantee the
      // outbox ack depends on.
      await db.withTransactionAsync(async () => {
        const row = await db.getFirstAsync<{ max_seq: number | null }>(
          'SELECT MAX(seq) AS max_seq FROM yjs_updates WHERE doc_id = ?',
          [localId(docId)]
        )
        await db.runAsync(
          'INSERT INTO yjs_updates (doc_id, seq, update_blob, created_at) VALUES (?, ?, ?, ?)',
          [localId(docId), (row?.max_seq ?? 0) + 1, update, Date.now()]
        )
      })
    }
  }
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
  void pending.then((session) => session.docs.closeAll()).catch(() => {})
}

async function build(vaultId: string): Promise<EditorSession> {
  const db = await openVaultDb(vaultId)
  const outbox = new OutboxStore(db)
  const docs = new EditorDocManager(createVaultDocStore(db), outbox)

  const http = createMobileHttpClient(syncBaseUrl())
  const clientHeaderValue = buildClientHeaderValue('ios', mobileAppVersion())
  const deviceId = await getOrCreateDeviceId()

  // Cached because the drain runs per foreground edge and per background
  // transition; a keychain read on each one is both slow and, on a locked
  // device, a prompt the user did not ask for.
  let accessToken = (await loadSession())?.accessToken ?? ''
  const vaultKey = await getVaultKey(vaultId)
  const keypair = await getDeviceSigningKeypair(vaultId)

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
    isOnline: () => online
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
    async flush() {
      const result = await drain.drain()
      // One retry after a token refresh: an expired access token is the single
      // most common reason a first drain of the day fails, and it is fixable
      // without waiting out a backoff the user would experience as lost work.
      if (result.failed > 0 && !result.parked) {
        const fresh = await refreshSession()
        if (fresh) {
          accessToken = fresh
          await drain.drain()
        }
      }
    }
  }
}
