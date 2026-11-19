import {
  CRDT_SYNC_ITEM_TYPES,
  RECORD_CLOCK_REQUIRED_ITEM_TYPES,
  RECORD_SYNC_ITEM_TYPES,
  RecordChangesResponseSchema,
  RecordPullResponseSchema,
  RecordSyncManifestSchema
} from '@memry/contracts/sync-api'
import type { ServerBody, ServerRecord, ServerVaultTruth } from './oracle.js'

export interface OracleServerClient {
  /** `http://localhost` for the harness Worker, the staging origin for staging scripts. */
  baseUrl: string
  accessToken: string
  fetch?: typeof globalThis.fetch
  /** Extra headers, such as the client identity header staging's version floor reads. */
  headers?: Record<string, string>
}

/** Server caps: manifest page 1000 (`MAX_MANIFEST_PAGE_LIMIT`), pull and CRDT batch 100. */
const MANIFEST_PAGE = 1000
const CHUNK = 100

const chunks = <T>(values: T[]): T[][] =>
  Array.from({ length: Math.ceil(values.length / CHUNK) }, (_, i) =>
    values.slice(i * CHUNK, (i + 1) * CHUNK)
  )

const request = async (
  client: OracleServerClient,
  path: string,
  body?: unknown
): Promise<unknown> => {
  const doFetch = client.fetch ?? globalThis.fetch
  const response = await doFetch(`${client.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${client.accessToken}`,
      'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(','),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...client.headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  if (!response.ok) {
    throw new Error(`oracle ${path} failed (${response.status}): ${await response.text()}`)
  }
  return response.json()
}

const fetchLiveRefs = async (client: OracleServerClient): Promise<Map<string, string>> => {
  const live = new Map<string, string>()
  let cursor = 0
  for (;;) {
    const page = RecordSyncManifestSchema.parse(
      await request(client, `/sync/manifest?limit=${MANIFEST_PAGE}&cursor=${cursor}`)
    )
    for (const item of page.items) live.set(item.id, item.type)
    if (page.nextCursor === undefined) return live
    cursor = page.nextCursor
  }
}

const fetchDeletedIds = async (
  client: OracleServerClient,
  live: Map<string, string>
): Promise<string[]> => {
  const deleted = new Set<string>()
  let cursor = 0
  for (;;) {
    const page = RecordChangesResponseSchema.parse(
      await request(client, `/sync/changes?limit=${CHUNK}&cursor=${cursor}`)
    )
    for (const id of page.deleted) deleted.add(id)
    if (!page.hasMore) break
    cursor = page.nextCursor
  }
  return [...deleted].filter((id) => !live.has(id))
}

const fetchClocks = async (
  client: OracleServerClient,
  live: Map<string, string>
): Promise<Record<string, ServerRecord>> => {
  const clockRequired = new Set<string>(RECORD_CLOCK_REQUIRED_ITEM_TYPES)
  const records: Record<string, ServerRecord> = {}
  for (const itemIds of chunks([...live.keys()])) {
    const page = RecordPullResponseSchema.parse(await request(client, '/sync/pull', { itemIds }))
    for (const item of page.items) {
      // A clockless row of a clock-required type would make any stale local
      // copy compare equal. Other types (settings) may be stored without one.
      if (!item.clock && clockRequired.has(item.type)) {
        throw new Error(`oracle: live ${item.type} ${item.id} has no clock`)
      }
      records[item.id] = { type: item.type, clock: item.clock ?? null }
    }
  }
  for (const [id, type] of live) {
    if (!records[id])
      throw new Error(`oracle: manifest lists ${type} ${id} but /sync/pull omits it`)
  }
  return records
}

interface BatchNote {
  updates: Array<{ sequenceNum: number }>
  hasMore: boolean
}

interface BatchResponse {
  notes: Record<string, BatchNote>
  snapshotMeta: Record<string, { sequenceNum: number; revision: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The batch response has no shared schema; read only the fields the oracle trusts. */
const parseBatch = (value: unknown): BatchResponse => {
  if (!isRecord(value) || !isRecord(value.notes) || !isRecord(value.snapshotMeta)) {
    throw new Error('oracle: /sync/crdt/updates/batch answered without notes or snapshotMeta')
  }
  const notes: Record<string, BatchNote> = {}
  for (const [id, note] of Object.entries(value.notes)) {
    if (!isRecord(note) || !Array.isArray(note.updates) || typeof note.hasMore !== 'boolean') {
      throw new Error(`oracle: malformed batch entry for ${id}`)
    }
    const updates = note.updates.map((update: unknown) => {
      if (!isRecord(update) || typeof update.sequenceNum !== 'number') {
        throw new Error(`oracle: malformed update for ${id}`)
      }
      return { sequenceNum: update.sequenceNum }
    })
    notes[id] = { updates, hasMore: note.hasMore }
  }
  const snapshotMeta: BatchResponse['snapshotMeta'] = {}
  for (const [id, meta] of Object.entries(value.snapshotMeta)) {
    if (
      !isRecord(meta) ||
      typeof meta.sequenceNum !== 'number' ||
      typeof meta.revision !== 'string'
    ) {
      throw new Error(`oracle: malformed snapshotMeta for ${id}`)
    }
    snapshotMeta[id] = { sequenceNum: meta.sequenceNum, revision: meta.revision }
  }
  return { notes, snapshotMeta }
}

const fetchBodies = async (
  client: OracleServerClient,
  live: Map<string, string>
): Promise<Record<string, ServerBody>> => {
  const crdtTypes = new Set<string>(CRDT_SYNC_ITEM_TYPES)
  const ids = [...live].filter(([, type]) => crdtTypes.has(type)).map(([id]) => id)
  const bodies: Record<string, ServerBody> = {}
  for (const id of ids) bodies[id] = { snapshot: null, updateSequences: [] }

  let pending = ids.map((noteId) => ({ noteId, since: 0 }))
  let firstPass = true
  while (pending.length > 0) {
    const next: typeof pending = []
    for (const notes of chunks(pending)) {
      const batch = parseBatch(await request(client, '/sync/crdt/updates/batch', { notes }))
      if (firstPass) {
        for (const [id, meta] of Object.entries(batch.snapshotMeta)) {
          if (bodies[id]) bodies[id].snapshot = meta
        }
      }
      // A note behind the 8 MB byte budget gets `updates: []` with `hasMore`
      // (crdt.ts planUpdatePage) and is asked again from the same `since`. The
      // first note of a request always fits, so a request where no note moves
      // would loop forever.
      let progressed = false
      for (const { noteId, since } of notes) {
        const page = batch.notes[noteId]
        if (!page) throw new Error(`oracle: batch omitted ${noteId}`)
        bodies[noteId].updateSequences.push(...page.updates.map((u) => u.sequenceNum))
        const last = page.updates.at(-1)
        if (last || !page.hasMore) progressed = true
        if (page.hasMore) next.push({ noteId, since: last?.sequenceNum ?? since })
      }
      if (!progressed) {
        throw new Error(
          `oracle: batch made no progress for ${notes.map((n) => n.noteId).join(',')}`
        )
      }
    }
    pending = next
    firstPass = false
  }
  return bodies
}

/**
 * The server side of the structural check: live records with their clocks from
 * `GET /sync/manifest` and `POST /sync/pull`, tombstoned ids from the change
 * feed, and every CRDT document's snapshot and update sequences from
 * `POST /sync/crdt/updates/batch`. Read while nothing writes to the vault: a
 * write during the read can show as a finding.
 */
export const fetchServerTruth = async (client: OracleServerClient): Promise<ServerVaultTruth> => {
  const live = await fetchLiveRefs(client)
  return {
    records: await fetchClocks(client, live),
    deleted: await fetchDeletedIds(client, live),
    bodies: await fetchBodies(client, live)
  }
}
