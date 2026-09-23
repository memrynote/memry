import { z } from 'zod'

/**
 * Vault activity: a device-local record of what happened to files the user put
 * into (or took out of) the vault from outside the app, what the importers
 * brought in, and what was skipped or failed along the way.
 *
 * It exists because every one of these outcomes used to surface only as a
 * toast (or not at all, for unsupported files), and a toast is gone before it
 * can be read. The log lives in `<vault>/.memry/activity.jsonl`: inside the
 * hidden folder the watcher and indexer already ignore, so it never becomes a
 * note and never syncs.
 *
 * Forward compatibility: the file is append-only JSON lines, and a reader drops
 * any line it cannot parse — including a kind or source a newer build added —
 * instead of failing the whole log.
 */

export const VAULT_ACTIVITY_KINDS = [
  /** A file appeared in the vault and was picked up. */
  'added',
  /** A known file disappeared from the vault. */
  'removed',
  /** A known file was renamed or moved outside the app. */
  'renamed',
  /** A file was seen but deliberately not picked up (e.g. unsupported type). */
  'skipped',
  /** Picking a file up, importing it, or syncing it failed. */
  'failed',
  /** Summary of one open-time vault scan that found something to report. */
  'scan',
  /** Summary of one importer run. */
  'import'
] as const
export const VaultActivityKindSchema = z.enum(VAULT_ACTIVITY_KINDS)
export type VaultActivityKind = z.infer<typeof VaultActivityKindSchema>

export const VAULT_ACTIVITY_SOURCES = [
  /** The live file watcher (changes made in Finder/Explorer, git, Dropbox…). */
  'watcher',
  /** The open-time walk, which catches changes made while the app was closed. */
  'scan',
  /** Settings → Import. */
  'import',
  /** Files dropped onto the sidebar. */
  'drop',
  /** Sync upload/download of a vault file. */
  'sync'
] as const
export const VaultActivitySourceSchema = z.enum(VAULT_ACTIVITY_SOURCES)
export type VaultActivitySource = z.infer<typeof VaultActivitySourceSchema>

/**
 * Coded reasons the renderer translates. Free text goes in `message` instead,
 * so an unknown code from a newer build still renders (as its message).
 */
export const VAULT_ACTIVITY_REASONS = [
  'unsupported-type',
  'read-failed',
  'index-failed',
  'copy-failed',
  'import-failed',
  'import-canceled',
  'attachment-upload-failed',
  'attachment-download-failed',
  'file-too-large',
  'note-too-large',
  'index-rebuilt'
] as const
export type VaultActivityReason = (typeof VAULT_ACTIVITY_REASONS)[number]

/** Upper bound on sample items stored with a summary entry. */
export const VAULT_ACTIVITY_MAX_ITEMS = 50

export const VaultActivityEntrySchema = z.object({
  v: z.literal(1),
  id: z.string().min(1),
  /** ISO timestamp. */
  at: z.string().min(1),
  kind: VaultActivityKindSchema,
  source: VaultActivitySourceSchema,
  /** Vault-relative path, when the entry is about one file. */
  path: z.string().optional(),
  /** Previous vault-relative path of a rename. */
  oldPath: z.string().optional(),
  /** A {@link VaultActivityReason}; kept as a string so newer codes still parse. */
  reason: z.string().optional(),
  /** Untranslated detail (error text, note title). */
  message: z.string().optional(),
  /** Importer id for `import` entries. */
  importer: z.string().optional(),
  /** Named counts for summary entries (`added`, `skipped`, `failed`, …). */
  counts: z.record(z.string(), z.number()).optional(),
  /** Sample lines for summary entries: paths, or `item — error`. */
  items: z.array(z.string()).max(VAULT_ACTIVITY_MAX_ITEMS).optional()
})
export type VaultActivityEntry = z.infer<typeof VaultActivityEntrySchema>

export const VAULT_ACTIVITY_RETENTION_DAYS = [7, 30, 90] as const
export type VaultActivityRetentionDays = (typeof VAULT_ACTIVITY_RETENTION_DAYS)[number]
export const VAULT_ACTIVITY_DEFAULT_RETENTION_DAYS: VaultActivityRetentionDays = 30

export const VaultActivityRetentionDaysSchema = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90)
])

export const VAULT_ACTIVITY_FILTERS = ['all', 'problems'] as const
export type VaultActivityFilter = (typeof VAULT_ACTIVITY_FILTERS)[number]

export const ListVaultActivitySchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  /** `problems` = skipped and failed entries, plus summaries that carry either. */
  filter: z.enum(VAULT_ACTIVITY_FILTERS).optional()
})
export type ListVaultActivityInput = z.infer<typeof ListVaultActivitySchema>

export interface ListVaultActivityResult {
  /** Newest first. */
  entries: VaultActivityEntry[]
  retentionDays: VaultActivityRetentionDays
  /** False when no vault is open. */
  available: boolean
}

export const SetVaultActivityRetentionSchema = z.object({
  days: VaultActivityRetentionDaysSchema
})
export type SetVaultActivityRetentionInput = z.infer<typeof SetVaultActivityRetentionSchema>

export const VaultActivityChannels = {
  invoke: {
    /** List retained entries, newest first */
    LIST: 'vault-activity:list',
    /** Drop every retained entry */
    CLEAR: 'vault-activity:clear',
    /** Change how many days entries are kept */
    SET_RETENTION: 'vault-activity:set-retention',
    /** Reveal the log file in Finder/Explorer */
    REVEAL: 'vault-activity:reveal'
  },
  events: {
    /** Entries were added or removed; payload-free, the renderer refetches */
    CHANGED: 'vault-activity:changed'
  }
} as const

export type VaultActivityInvokeChannel =
  (typeof VaultActivityChannels.invoke)[keyof typeof VaultActivityChannels.invoke]
