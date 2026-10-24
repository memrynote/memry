import { eq } from 'drizzle-orm'
import { settings } from '@memry/db-schema/data-schema'
import { readwiseLinks } from '@memry/db-schema/schema/readwise-links'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import {
  READWISE_CADENCES,
  READWISE_CATEGORIES,
  READWISE_FOLDER_LAYOUTS,
  READWISE_OPTIONS_DEFAULTS,
  ReadwiseSetOptionsSchema,
  type ReadwiseErrorKind,
  type ReadwiseOptions,
  type ReadwiseRunCounts,
  type ReadwiseSetOptionsInput
} from '@memry/contracts/import-channels'
import { utcNow } from '@memry/shared/utc'
import type { DataDb } from './database.ts'

// The CLI's slice of the Readwise importer (apps/desktop/src/main/readwise/
// settings.ts, sync-state.ts, claim.ts, connection.ts). What it can do reads
// and writes data.db only. The token lives in the OS keychain and every pull
// runs inside the desktop app's scheduler, so connecting, syncing and the
// per-book commands stay with the desktop app: `desktopOnly` names them.

const GROUP_KEY = 'readwise'
const CURSOR_KEY = 'readwise.cursor'
const FULL_PASS_KEY = 'readwise.fullPass'
const LAST_RUN_KEY = 'readwise.lastRun'

/** Commands that need the desktop app: its keychain token, network client, or running scheduler. */
export const READWISE_DESKTOP_ONLY_COMMANDS = [
  'sync-now',
  'restore-book',
  'reimport-book',
  'refresh-book',
  'take-over'
] as const

export interface ReadwiseCliStatus {
  /**
   * Whether a token is stored. Null: the token is kept in the OS keychain,
   * which the CLI never reads. A completed run (`lastSyncAt`) means one was.
   */
  connected: null
  options: ReadwiseOptions
  lastSyncAt: string | null
  needsAttention: boolean
  attention: ReadwiseErrorKind | null
  /** A run has completed on this device, so the next one is not the first import. */
  hasImported: boolean
  lastRun: ReadwiseRunCounts | null
  pullingDevice: { id: string; name: string | null; isThisDevice: boolean } | null
}

export interface ReadwiseDeletedLink {
  readwiseBookId: number
  noteId: string
  /** ISO time the link row went to `note-deleted`. */
  deletedAt: string
}

export interface ReadwiseService {
  status(): Promise<ReadwiseCliStatus>
  listDeleted(): Promise<ReadwiseDeletedLink[]>
  setOptions(updates: ReadwiseSetOptionsInput): Promise<ReadwiseCliStatus>
}

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
      (value as T)
    : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createReadwiseService(dataDb: DataDb): ReadwiseService {
  function getSetting(key: string): string | null {
    return (
      dataDb.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
        ?.value ?? null
    )
  }

  function setSetting(key: string, value: string): void {
    const modifiedAt = utcNow()
    dataDb
      .insert(settings)
      .values({ key, value, modifiedAt })
      .onConflictDoUpdate({ target: settings.key, set: { value, modifiedAt } })
      .run()
  }

  function readGroup(): Record<string, unknown> {
    const raw = getSetting(GROUP_KEY)
    if (raw === null) return {}
    try {
      const parsed: unknown = JSON.parse(raw)
      return isRecord(parsed) ? parsed : {}
    } catch {
      // The row holds only the user's choices; defaults take over, as on desktop.
      return {}
    }
  }

  /** Stored values over the defaults. A value only a newer build knows reads as the default. */
  function readOptions(): ReadwiseOptions {
    const stored = readGroup()
    const defaults = READWISE_OPTIONS_DEFAULTS
    const storedCategories = isRecord(stored.categories) ? stored.categories : {}
    const categories = { ...defaults.categories }
    for (const category of READWISE_CATEGORIES) {
      const value = storedCategories[category]
      if (typeof value === 'boolean') categories[category] = value
    }
    return {
      rootFolder:
        typeof stored.rootFolder === 'string' && stored.rootFolder.trim()
          ? stored.rootFolder
          : defaults.rootFolder,
      folderLayout: oneOf(READWISE_FOLDER_LAYOUTS, stored.folderLayout, defaults.folderLayout),
      categories,
      cadence: oneOf(READWISE_CADENCES, stored.cadence, defaults.cadence),
      readerDocuments:
        typeof stored.readerDocuments === 'boolean'
          ? stored.readerDocuments
          : defaults.readerDocuments,
      readerFullText:
        typeof stored.readerFullText === 'boolean'
          ? stored.readerFullText
          : defaults.readerFullText,
      journalHighlights:
        typeof stored.journalHighlights === 'boolean'
          ? stored.journalHighlights
          : defaults.journalHighlights
    }
  }

  function readLastRun(): {
    at: string
    needsAttention: boolean
    attention: ReadwiseErrorKind | null
    counts: ReadwiseRunCounts | null
  } | null {
    const raw = getSetting(LAST_RUN_KEY)
    if (raw === null) return null
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed) || typeof parsed.at !== 'string') return null
      const needsAttention = parsed.needsAttention === true
      return {
        at: parsed.at,
        needsAttention,
        // A value an older build wrote has no kind: it parked on a revoked token.
        attention: needsAttention
          ? oneOf(
              ['invalid-token', 'subscription-expired'] as const,
              parsed.attention,
              'invalid-token'
            )
          : null,
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- partial value cast through its boundary type; precise type is not available
        counts: isRecord(parsed.counts) ? (parsed.counts as unknown as ReadwiseRunCounts) : null
      }
    } catch {
      return null
    }
  }

  function pullingDevice(): ReadwiseCliStatus['pullingDevice'] {
    const group = readGroup()
    const id =
      typeof group.syncDeviceId === 'string' && group.syncDeviceId ? group.syncDeviceId : null
    if (id === null) return null
    const name =
      typeof group.syncDeviceName === 'string' && group.syncDeviceName ? group.syncDeviceName : null
    const current = dataDb
      .select({ id: syncDevices.id })
      .from(syncDevices)
      .where(eq(syncDevices.isCurrentDevice, true))
      .get()
    return { id, name, isThisDevice: current?.id === id }
  }

  function status(): ReadwiseCliStatus {
    const lastRun = readLastRun()
    return {
      connected: null,
      options: readOptions(),
      lastSyncAt: lastRun?.at ?? null,
      needsAttention: lastRun?.needsAttention ?? false,
      attention: lastRun?.attention ?? null,
      hasImported: getSetting(CURSOR_KEY) !== null,
      lastRun: lastRun?.counts ?? null,
      pullingDevice: pullingDevice()
    }
  }

  return {
    async status() {
      return status()
    },

    async listDeleted() {
      return dataDb
        .select()
        .from(readwiseLinks)
        .where(eq(readwiseLinks.state, 'note-deleted'))
        .all()
        .filter((row) => row.readwiseBookId !== null)
        .map((row) => ({
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- boundary value (JSON, SQL row or test double) whose shape the producer fixes
          readwiseBookId: row.readwiseBookId as number,
          noteId: row.noteId,
          deletedAt: row.updatedAt
        }))
        .toSorted((a, b) => b.deletedAt.localeCompare(a.deletedAt))
    },

    async setOptions(rawUpdates) {
      const updates = ReadwiseSetOptionsSchema.parse(rawUpdates)
      const stored = readGroup()
      const next: Record<string, unknown> = { ...stored }
      let changed = false
      if (updates.rootFolder !== undefined) {
        next.rootFolder = updates.rootFolder
        changed = true
      }
      if (updates.folderLayout !== undefined) {
        next.folderLayout = updates.folderLayout
        changed = true
      }
      if (updates.cadence !== undefined) {
        next.cadence = updates.cadence
        changed = true
      }
      if (updates.readerDocuments !== undefined) {
        next.readerDocuments = updates.readerDocuments
        changed = true
      }
      if (updates.readerFullText !== undefined) {
        next.readerFullText = updates.readerFullText
        changed = true
      }
      if (updates.journalHighlights !== undefined) {
        next.journalHighlights = updates.journalHighlights
        changed = true
      }
      if (updates.categories) {
        const categories: Record<string, unknown> = isRecord(stored.categories)
          ? { ...stored.categories }
          : {}
        for (const [category, enabled] of Object.entries(updates.categories)) {
          if (enabled === undefined) continue
          categories[category] = enabled
          changed = true
        }
        next.categories = categories
      }
      if (!changed) return status()

      const before = readOptions()
      setSetting(GROUP_KEY, JSON.stringify(next))
      // A category (or the saved-documents switch) going from off to on needs its books read
      // once, and the export has no category filter: flag the next run as a full pass.
      const after = readOptions()
      if (
        (after.readerDocuments && !before.readerDocuments) ||
        READWISE_CATEGORIES.some(
          (category) => after.categories[category] && !before.categories[category]
        )
      ) {
        setSetting(FULL_PASS_KEY, 'true')
      }
      return status()
    }
  }
}
