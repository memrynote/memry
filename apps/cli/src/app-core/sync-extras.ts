import fs from 'node:fs/promises'
import path from 'node:path'
import { and, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm'
import type {
  LargeNotesResult,
  NoteSyncState,
  NoteSyncStateValue,
  UnsentNoteEntry,
  UnsentNoteReason,
  UnsentNotesResult
} from '@memry/contracts/ipc-sync-ops'
import {
  crdtOwedFileBodies,
  noteMetadata,
  settings as settingsTable,
  syncDevices,
  syncQueue
} from '@memry/db-schema/data-schema'
import { noteBodySync } from '@memry/db-schema/schema/note-body-sync'
import { isBinaryFileType } from '@memry/shared/file-types'
import type { DataDb } from './database.ts'

/** `NOTE_BODY_QUEUE_TYPE` in `@memry/sync-client/queue`. */
const NOTE_BODY_QUEUE_TYPE = 'note_body'
const NOTE_RECORD_TYPES = ['note', 'journal']
const QUEUE_TYPES = [NOTE_BODY_QUEUE_TYPE, ...NOTE_RECORD_TYPES]
const IN_LIST_CHUNK = 500
/** Same cap as desktop's `MAX_UNSENT_NOTES` and large-notes `MAX_ENTRIES`. */
const MAX_UNSENT_NOTES = 200
const MAX_LARGE_NOTES = 50
/** Same ceiling as `@memry/sync-client/note-size`; a parity test pins them together. */
export const NOTE_SYNC_MAX_BYTES = Math.floor((5 * 1024 * 1024) / 1.37)
export const NOTE_SYNC_WARN_BYTES = Math.floor(NOTE_SYNC_MAX_BYTES * 0.8)
/** `VAULT_ACCOUNT_BINDING_SETTING` in desktop's vault-account-binding.ts. */
const VAULT_ACCOUNT_BINDING_SETTING = 'sync.account-binding.v1'

interface WaitingChanges {
  body: number | null
  record: number | null
  fileNotTaken: number | null
}

const NO_WAITING: WaitingChanges = { body: null, record: null, fileNotTaken: null }

export interface VaultBindingReport {
  status: 'unbound' | 'sync' | 'local-only'
  mode: 'sync' | 'local' | null
}

export interface SyncExtrasService {
  noteState(noteIdOrPath: string): Promise<NoteSyncState | null>
  unsentNotes(): Promise<UnsentNotesResult>
  largeNotes(): Promise<LargeNotesResult>
  binding(): Promise<VaultBindingReport>
  trigger(): Promise<never>
  progress(): Promise<never>
  renameDevice(deviceId: string, name: string): Promise<never>
  removeDevice(deviceId: string): Promise<never>
}

function oldest(...times: Array<number | null>): number | null {
  const present = times.filter((time): time is number => time !== null)
  return present.length === 0 ? null : Math.min(...present)
}

export function classifyNoteSyncSize(bytes: number): 'ok' | 'approaching' | 'over' {
  if (bytes > NOTE_SYNC_MAX_BYTES) return 'over'
  if (bytes >= NOTE_SYNC_WARN_BYTES) return 'approaching'
  return 'ok'
}

type PushRow = typeof noteBodySync.$inferSelect

/** Desktop's `deriveNoteSyncState` (main/sync/note-sync-state.ts). */
export function deriveNoteSyncState(
  facts: { localOnly: boolean; waiting: WaitingChanges; pushes: PushRow | null },
  syncEligible: boolean
): NoteSyncState {
  const pushes = facts.pushes
  const waitingSince = oldest(facts.waiting.body, facts.waiting.record, facts.waiting.fileNotTaken)
  const confirmed = pushes?.lastConfirmedAt ?? null
  const failed = pushes?.lastFailedAt ?? null
  const rejected = pushes?.lastRejectedAt ?? null
  const sent = pushes?.lastSentAt ?? null
  const snapshot = pushes?.lastSnapshotAt ?? null

  let state: NoteSyncStateValue
  if (!syncEligible) state = 'not_syncing'
  else if (facts.localOnly) state = 'local_only'
  else if (waitingSince !== null) {
    const retrying = failed !== null && failed > (confirmed ?? -1)
    const answered = Math.max(confirmed ?? -1, rejected ?? -1)
    state = !retrying && sent !== null && sent > answered ? 'sent' : 'pending'
  } else if (rejected !== null && rejected > (snapshot ?? -1)) state = 'rejected'
  else state = confirmed === null ? 'not_recorded' : 'confirmed'

  return {
    state,
    waitingSince,
    lastSentAt: sent,
    bodyConfirmedAt: confirmed,
    lastFailedAt: failed,
    lastRejectedAt: rejected
  }
}

function chunks<T>(items: T[]): T[][] {
  const out: T[][] = []
  for (let index = 0; index < items.length; index += IN_LIST_CHUNK) {
    out.push(items.slice(index, index + IN_LIST_CHUNK))
  }
  return out
}

const needsDesktop = (what: string): Error =>
  new Error(`${what} needs the Memry desktop app: it holds the sync session and keys.`)

export function createSyncExtrasService({
  dataDb,
  vaultPath
}: {
  dataDb: DataDb
  vaultPath: string
}): SyncExtrasService {
  // The CLI cannot see desktop's in-memory "sync runtime is up" flag. A linked
  // device row is the closest durable fact: no row means this vault never synced.
  function syncEligible(): boolean {
    return !!dataDb
      .select({ id: syncDevices.id })
      .from(syncDevices)
      .where(eq(syncDevices.isCurrentDevice, true))
      .get()
  }

  function readWaiting(noteIds: string[]): Map<string, WaitingChanges> {
    const waiting = new Map<string, WaitingChanges>()
    const entry = (noteId: string): WaitingChanges => {
      let found = waiting.get(noteId)
      if (!found) {
        found = { ...NO_WAITING }
        waiting.set(noteId, found)
      }
      return found
    }
    for (const ids of chunks(noteIds)) {
      const queued = dataDb
        .select({
          itemId: syncQueue.itemId,
          type: syncQueue.type,
          createdAt: sql<number>`min(${syncQueue.createdAt})`
        })
        .from(syncQueue)
        .where(and(inArray(syncQueue.itemId, ids), inArray(syncQueue.type, QUEUE_TYPES)))
        .groupBy(syncQueue.itemId, syncQueue.type)
        .all()
      for (const row of queued) {
        const changes = entry(row.itemId)
        const at = row.createdAt * 1000
        if (row.type === NOTE_BODY_QUEUE_TYPE) changes.body = oldest(changes.body, at)
        else changes.record = oldest(changes.record, at)
      }
      for (const row of dataDb
        .select()
        .from(crdtOwedFileBodies)
        .where(inArray(crdtOwedFileBodies.noteId, ids))
        .all()) {
        entry(row.noteId).fileNotTaken = row.createdAt
      }
    }
    return waiting
  }

  function readPushes(noteIds: string[]): Map<string, PushRow> {
    const pushes = new Map<string, PushRow>()
    for (const ids of chunks(noteIds)) {
      for (const row of dataDb
        .select()
        .from(noteBodySync)
        .where(inArray(noteBodySync.noteId, ids))
        .all()) {
        pushes.set(row.noteId, row)
      }
    }
    return pushes
  }

  // `note_metadata` is where the CLI keeps notes (desktop's `note_cache` is its
  // projection), so it also answers for notes the desktop has not indexed yet.
  function readMeta(noteIds: string[]) {
    const meta = new Map<
      string,
      { id: string; title: string; path: string; localOnly: boolean | null }
    >()
    for (const ids of chunks(noteIds)) {
      for (const row of dataDb
        .select({
          id: noteMetadata.id,
          title: noteMetadata.title,
          path: noteMetadata.path,
          localOnly: noteMetadata.localOnly
        })
        .from(noteMetadata)
        .where(inArray(noteMetadata.id, ids))
        .all()) {
        meta.set(row.id, row)
      }
    }
    return meta
  }

  return {
    async noteState(noteIdOrPath) {
      const row = dataDb
        .select({ id: noteMetadata.id })
        .from(noteMetadata)
        .where(or(eq(noteMetadata.id, noteIdOrPath), eq(noteMetadata.path, noteIdOrPath)))
        .get()
      if (!row) return null
      const meta = readMeta([row.id]).get(row.id)
      return deriveNoteSyncState(
        {
          localOnly: meta?.localOnly === true,
          waiting: readWaiting([row.id]).get(row.id) ?? NO_WAITING,
          pushes: readPushes([row.id]).get(row.id) ?? null
        },
        syncEligible()
      )
    },

    async unsentNotes() {
      const eligible = syncEligible()
      const candidates = new Set<string>()
      for (const row of dataDb
        .selectDistinct({ itemId: syncQueue.itemId })
        .from(syncQueue)
        .where(inArray(syncQueue.type, QUEUE_TYPES))
        .all()) {
        candidates.add(row.itemId)
      }
      for (const row of dataDb
        .select({ noteId: crdtOwedFileBodies.noteId })
        .from(crdtOwedFileBodies)
        .all()) {
        candidates.add(row.noteId)
      }
      for (const row of dataDb
        .select({ noteId: noteBodySync.noteId })
        .from(noteBodySync)
        .where(
          or(
            and(
              sql`${noteBodySync.lastRejectedAt} IS NOT NULL`,
              isNull(noteBodySync.lastSnapshotAt)
            ),
            gt(noteBodySync.lastRejectedAt, noteBodySync.lastSnapshotAt)
          )
        )
        .all()) {
        candidates.add(row.noteId)
      }

      const ids = [...candidates]
      const meta = readMeta(ids)
      const known = ids.filter((id) => meta.has(id) && meta.get(id)?.localOnly !== true)
      const waiting = readWaiting(known)
      const pushes = readPushes(known)

      const notes: UnsentNoteEntry[] = []
      for (const id of known) {
        const note = meta.get(id)!
        const changes = waiting.get(id) ?? NO_WAITING
        const state = deriveNoteSyncState(
          { localOnly: false, waiting: changes, pushes: pushes.get(id) ?? null },
          eligible
        )
        const reasons: UnsentNoteReason[] = []
        if (changes.body !== null) reasons.push('body')
        if (changes.record !== null) reasons.push('record')
        if (changes.fileNotTaken !== null) reasons.push('file_not_taken')
        if (state.state === 'rejected') reasons.push('rejected')
        if (reasons.length === 0) continue
        notes.push({
          id,
          title: note.title,
          path: note.path,
          state: state.state,
          waitingSince: state.waitingSince,
          reasons
        })
      }
      notes.sort((left, right) => {
        const leftRejected = left.reasons.includes('rejected') ? 0 : 1
        const rightRejected = right.reasons.includes('rejected') ? 0 : 1
        if (leftRejected !== rightRejected) return leftRejected - rightRejected
        return (
          (left.waitingSince ?? Number.MAX_SAFE_INTEGER) -
          (right.waitingSince ?? Number.MAX_SAFE_INTEGER)
        )
      })
      return { total: notes.length, notes: notes.slice(0, MAX_UNSENT_NOTES) }
    },

    async largeNotes() {
      const rows = dataDb
        .select({
          id: noteMetadata.id,
          title: noteMetadata.title,
          path: noteMetadata.path,
          fileType: noteMetadata.fileType,
          localOnly: noteMetadata.localOnly
        })
        .from(noteMetadata)
        .all()
      const entries: LargeNotesResult['notes'] = []
      for (const row of rows) {
        if (row.fileType && isBinaryFileType(row.fileType)) continue
        if (row.localOnly) continue
        let sizeBytes: number
        try {
          sizeBytes = (await fs.stat(path.join(vaultPath, row.path))).size
        } catch {
          continue
        }
        const status = classifyNoteSyncSize(sizeBytes)
        if (status === 'ok') continue
        entries.push({ id: row.id, title: row.title, path: row.path, sizeBytes, status })
      }
      entries.sort((left, right) => right.sizeBytes - left.sizeBytes)
      return { maxBytes: NOTE_SYNC_MAX_BYTES, notes: entries.slice(0, MAX_LARGE_NOTES) }
    },

    // The vault's stored account choice. Desktop's richer `needs-decision` and
    // `foreign` states come from a server check against the signed-in account.
    async binding() {
      const row = dataDb
        .select({ value: settingsTable.value })
        .from(settingsTable)
        .where(eq(settingsTable.key, VAULT_ACCOUNT_BINDING_SETTING))
        .get()
      if (!row) return { status: 'unbound', mode: null }
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- untyped JSON or driver result; shape fixed by the producer, a runtime parser would change accepted input
        const parsed = JSON.parse(row.value) as { userId?: unknown; mode?: unknown }
        if (typeof parsed.userId === 'string' && parsed.mode === 'sync') {
          return { status: 'sync', mode: 'sync' }
        }
        if (typeof parsed.userId === 'string' && parsed.mode === 'local') {
          return { status: 'local-only', mode: 'local' }
        }
      } catch {
        // A malformed row reads as unbound, as in desktop's readVaultAccountBinding.
      }
      return { status: 'unbound', mode: null }
    },

    async trigger() {
      throw needsDesktop('Sync now')
    },

    async progress() {
      throw new Error(
        'Attachment transfer progress is held in memory by the running Memry desktop app. Use `sync status` and `sync queue-size` for what is waiting.'
      )
    },

    async renameDevice() {
      throw needsDesktop('Renaming a device')
    },

    async removeDevice() {
      throw needsDesktop('Removing a device')
    }
  }
}
