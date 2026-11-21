/**
 * The heal of a note or journal day re-created on a build before #5358
 * (#5354, protocol 07 §7.15).
 *
 * Such a build kept the deleted day's doc and authored the new text on top of
 * it. The server had purged the deleted body, so it holds only the new
 * updates, whose parents are gone: every fresh device keeps them pending and
 * shows the day empty. Only the author still holds the parents, so it
 * re-pushes its full state once through the note-body outbox. The deleted text
 * comes back beside the new text; that is accepted, the alternative loses the
 * new text.
 *
 * A candidate is a live, syncable note with a recorded tombstone, nothing of
 * it queued, and no earlier verdict. Its server body is read into a scratch
 * doc, and the full state is queued only when that body is pending and the
 * local state completes it. Each verdict is kept in `sync_state`, so a note is
 * read and pushed at most once.
 */
import { eq, like } from 'drizzle-orm'
import * as Y from 'yjs'
import { syncState } from '@memry/db-schema/schema/sync-state'
import { syncTombstoneClocks } from '@memry/db-schema/schema/sync-tombstone-clocks'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createLogger } from '../lib/logger'
import { NetworkError, RateLimitError, SyncServerError } from '@memry/sync-client/http-errors'
import { decryptCrdtUpdate } from './crdt-encrypt'
import { getFromServer, type CrdtSnapshotMeta, type CrdtSnapshotResponse } from './http-client'

const log = createLogger('ReviveHeal')

const MARKER_PREFIX = 'sync.reviveHeal:'
/** When a candidate was last read without a verdict; it then waits behind the others. */
const TRIED_PREFIX = 'sync.reviveHealTried:'
const MAX_PAGES = 50
/** Notes judged per run; the rest wait for the next run. */
const MAX_NOTES_PER_RUN = 50
const RUN_INTERVAL_MS = 10 * 60 * 1000

export type ReviveHealVerdict = 'healthy' | 'healed' | 'unhealable'

export interface ReviveHealDeps {
  db: DrizzleDb
  isNoteSyncable: (noteId: string) => boolean
  hasQueuedChange: (noteId: string) => boolean
  /** The server's body, opened; `null` when it cannot be judged. */
  readServerBody: (noteId: string) => Promise<Uint8Array[] | null>
  readLocalState: (noteId: string) => Promise<Uint8Array | null>
  enqueueFullState: (noteId: string) => void
}

const isPending = (doc: Y.Doc): boolean =>
  doc.store.pendingStructs !== null || doc.store.pendingDs !== null

/** Whether a fresh device integrates the server body, and whether `local` would make it. */
export function judgeRevivedBody(
  server: Uint8Array[],
  local: Uint8Array | null
): ReviveHealVerdict {
  const doc = new Y.Doc()
  try {
    for (const update of server) Y.applyUpdate(doc, update)
    if (!isPending(doc)) return 'healthy'
    if (!local) return 'unhealable'
    Y.applyUpdate(doc, local)
    return isPending(doc) ? 'unhealable' : 'healed'
  } finally {
    doc.destroy()
  }
}

function markers(db: DrizzleDb, prefix: string): Map<string, number> {
  return new Map(
    db
      .select({ key: syncState.key, updatedAt: syncState.updatedAt })
      .from(syncState)
      .where(like(syncState.key, `${prefix}%`))
      .all()
      .map((row) => [row.key.slice(prefix.length), row.updatedAt?.getTime() ?? 0])
  )
}

/** Never tried first, then the longest untried, so no-verdict notes do not block the rest. */
function candidates(deps: ReviveHealDeps): string[] {
  const judged = markers(deps.db, MARKER_PREFIX)
  const tried = markers(deps.db, TRIED_PREFIX)
  return deps.db
    .select({ itemId: syncTombstoneClocks.itemId })
    .from(syncTombstoneClocks)
    .where(eq(syncTombstoneClocks.type, 'note'))
    .all()
    .map((row) => row.itemId)
    .filter((id) => !judged.has(id) && deps.isNoteSyncable(id) && !deps.hasQueuedChange(id))
    .toSorted((a, b) => (tried.get(a) ?? 0) - (tried.get(b) ?? 0))
}

function write(db: DrizzleDb, key: string, value: string, updatedAt: Date): void {
  db.insert(syncState)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}

function mark(db: DrizzleDb, noteId: string, verdict: ReviveHealVerdict): void {
  write(db, `${MARKER_PREFIX}${noteId}`, verdict, new Date())
  db.delete(syncState)
    .where(eq(syncState.key, `${TRIED_PREFIX}${noteId}`))
    .run()
}

// Strictly increasing, so two notes tried in one millisecond keep their order.
let lastTriedAt = 0
function markTried(db: DrizzleDb, noteId: string): void {
  lastTriedAt = Math.max(Date.now(), lastTriedAt + 1)
  write(db, `${TRIED_PREFIX}${noteId}`, 'tried', new Date(lastTriedAt))
}

/** A failure every later read of this run would repeat: a 429, no network, or a refused session. */
const endsTheRun = (error: unknown): boolean =>
  error instanceof RateLimitError ||
  error instanceof NetworkError ||
  (error instanceof SyncServerError && (error.statusCode === 401 || error.statusCode === 403))

/** Judges the candidates and queues the full state of each the server holds pending. */
export async function runReviveHeal(deps: ReviveHealDeps, signal?: AbortSignal): Promise<number> {
  let healed = 0
  for (const noteId of candidates(deps).slice(0, MAX_NOTES_PER_RUN)) {
    if (signal?.aborted) break
    let server: Uint8Array[] | null
    try {
      server = await deps.readServerBody(noteId)
    } catch (error) {
      log.warn('Server body of a revived note could not be read', { noteId, error })
      if (endsTheRun(error)) break
      markTried(deps.db, noteId)
      continue
    }
    if (signal?.aborted) break
    if (!server) {
      markTried(deps.db, noteId)
      continue
    }
    // Re-checked after the read: an edit queued meanwhile is pushed first.
    if (!deps.isNoteSyncable(noteId) || deps.hasQueuedChange(noteId)) continue
    let local: Uint8Array | null
    try {
      local = await deps.readLocalState(noteId)
    } catch (error) {
      // A torn-down provider or a locked database: no verdict, a later run retries.
      log.warn('Local state of a revived note could not be read', { noteId, error })
      markTried(deps.db, noteId)
      continue
    }
    if (signal?.aborted) break
    const verdict = judgeRevivedBody(server, local)
    if (verdict === 'healed') {
      deps.enqueueFullState(noteId)
      healed++
    }
    mark(deps.db, noteId, verdict)
    log.info('Revived body judged', { noteId, verdict })
  }
  return healed
}

interface ServerBodyAccess {
  getAccessToken: () => Promise<string | null>
  getVaultKey: () => Promise<Uint8Array | null>
  getDevicePublicKey: (deviceId: string) => Promise<Uint8Array | null>
}

interface UpdatesPage {
  updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string }>
  hasMore: boolean
  /** `null` with no snapshot; absent from a server before #2299. */
  snapshotMeta?: CrdtSnapshotMeta | null
}

/**
 * The snapshot, then every update above it, each verified and opened. `null`
 * when the body cannot be judged: a snapshot or update that does not open, a
 * log longer than the page cap, or a snapshot that changed between the reads.
 */
export function createServerBodyReader(
  access: ServerBodyAccess
): (noteId: string) => Promise<Uint8Array[] | null> {
  return async (noteId) => {
    const token = await access.getAccessToken()
    const vaultKey = await access.getVaultKey()
    if (!token || !vaultKey) return null
    const open = async (packed: Uint8Array, signer: string): Promise<Uint8Array | null> => {
      const key = await access.getDevicePublicKey(signer)
      return key ? decryptCrdtUpdate(packed, vaultKey, noteId, key) : null
    }
    const body: Uint8Array[] = []
    let since = 0
    const snapshot = await getFromServer<CrdtSnapshotResponse>(
      `/sync/crdt/snapshot/${encodeURIComponent(noteId)}`,
      token
    )
    const revision = snapshot.snapshot ? (snapshot.revision ?? null) : null
    if (snapshot.snapshot) {
      if (!snapshot.signerDeviceId) return null
      const opened = await open(
        new Uint8Array(Buffer.from(snapshot.snapshot, 'base64')),
        snapshot.signerDeviceId
      )
      if (!opened) return null
      body.push(opened)
      since = snapshot.sequenceNum
    }
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await getFromServer<UpdatesPage>(
        `/sync/crdt/updates?note_id=${encodeURIComponent(noteId)}&since=${since}&limit=100`,
        token
      )
      // A snapshot claimed after the read above pruned the rows it covers, so
      // a healthy body would read as pending.
      if ((result.snapshotMeta?.revision ?? null) !== revision) return null
      for (const entry of result.updates) {
        if (entry.sequenceNum <= since) continue
        const opened = await open(
          new Uint8Array(Buffer.from(entry.data, 'base64')),
          entry.signerDeviceId
        )
        if (!opened) return null
        body.push(opened)
        since = entry.sequenceNum
      }
      if (!result.hasMore) return body
    }
    return null
  }
}

let timer: NodeJS.Timeout | null = null
let abort: AbortController | null = null
let running = false

/** Runs at sync start and every ten minutes, each time only once a full sync delivered this session. */
function start(deps: ReviveHealDeps, isCaughtUpWithServer: () => boolean): void {
  stop()
  const controller = new AbortController()
  abort = controller
  const run = async (): Promise<void> => {
    if (running || controller.signal.aborted || !isCaughtUpWithServer()) return
    running = true
    try {
      const healed = await runReviveHeal(deps, controller.signal)
      if (healed > 0) log.info('Re-pushed revived bodies', { healed })
    } catch (error) {
      log.warn('Revive heal run failed', { error })
    } finally {
      running = false
    }
  }
  void run()
  timer = setInterval(() => void run(), RUN_INTERVAL_MS)
  timer.unref?.()
}

function stop(): void {
  if (timer) clearInterval(timer)
  timer = null
  abort?.abort()
  abort = null
}

export const reviveHealRunner = { start, stop }
