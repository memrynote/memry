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
import { decryptCrdtUpdate } from './crdt-encrypt'
import { fetchCrdtSnapshot, getFromServer } from './http-client'

const log = createLogger('ReviveHeal')

const MARKER_PREFIX = 'sync.reviveHeal:'
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

function candidates(deps: ReviveHealDeps): string[] {
  const judged = new Set(
    deps.db
      .select({ key: syncState.key })
      .from(syncState)
      .where(like(syncState.key, `${MARKER_PREFIX}%`))
      .all()
      .map((row) => row.key.slice(MARKER_PREFIX.length))
  )
  return deps.db
    .select({ itemId: syncTombstoneClocks.itemId })
    .from(syncTombstoneClocks)
    .where(eq(syncTombstoneClocks.type, 'note'))
    .all()
    .map((row) => row.itemId)
    .filter((id) => !judged.has(id) && deps.isNoteSyncable(id) && !deps.hasQueuedChange(id))
}

function mark(db: DrizzleDb, noteId: string, verdict: ReviveHealVerdict): void {
  const key = `${MARKER_PREFIX}${noteId}`
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key, value: verdict, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value: verdict, updatedAt } })
    .run()
}

/** Judges the candidates and queues the full state of each the server holds pending. */
export async function runReviveHeal(deps: ReviveHealDeps): Promise<number> {
  let healed = 0
  for (const noteId of candidates(deps).slice(0, MAX_NOTES_PER_RUN)) {
    let server: Uint8Array[] | null
    try {
      server = await deps.readServerBody(noteId)
    } catch (error) {
      log.warn('Server body of a revived note could not be read', { noteId, error })
      continue
    }
    if (!server) continue
    // Re-checked after the read: an edit queued meanwhile is pushed first.
    if (!deps.isNoteSyncable(noteId) || deps.hasQueuedChange(noteId)) continue
    let verdict: ReviveHealVerdict
    try {
      verdict = judgeRevivedBody(server, await deps.readLocalState(noteId))
    } catch (error) {
      log.warn('Revived body could not be judged', { noteId, error })
      verdict = 'unhealable'
    }
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
}

/** The snapshot, then every update above it, each verified and opened. */
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
    const snapshot = await fetchCrdtSnapshot(noteId, token)
    if (snapshot) {
      const opened = await open(snapshot.snapshot, snapshot.signerDeviceId)
      if (!opened) return null
      body.push(opened)
      since = snapshot.sequenceNum
    }
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = await getFromServer<UpdatesPage>(
        `/sync/crdt/updates?note_id=${encodeURIComponent(noteId)}&since=${since}&limit=100`,
        token
      )
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
let running = false

/** Runs at sync start and every ten minutes, each time only once a full sync delivered this session. */
function start(deps: ReviveHealDeps, isCaughtUpWithServer: () => boolean): void {
  stop()
  const run = async (): Promise<void> => {
    if (running || !isCaughtUpWithServer()) return
    running = true
    try {
      const healed = await runReviveHeal(deps)
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
}

export const reviveHealRunner = { start, stop }
