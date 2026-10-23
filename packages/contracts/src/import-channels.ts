/**
 * Import IPC Channels + Schemas
 *
 * Generic import framework boundary: the renderer starts/cancels an import
 * run and subscribes to streaming progress. Importer-specific logic lives in
 * the main process (see apps/desktop/src/main/import).
 *
 * @module shared/import-channels
 */

import { z } from 'zod'

export const ImportChannels = {
  invoke: {
    /** Open a native file picker filtered to an importer's extensions. */
    PICK_FILES: 'import:pick-files',
    /** Start an import run (resolves with the final summary). */
    START: 'import:start',
    /** Cancel an in-flight import run by id. */
    CANCEL: 'import:cancel',
    /** Run an importer's optional preview (no writes). */
    PREVIEW: 'import:preview',
    /** List registered importers' metadata for the Settings catalog. */
    LIST: 'import:list'
  },
  events: {
    /** Streaming progress for a run, keyed by importId. */
    PROGRESS: 'import:progress'
  }
} as const

export const ImportPickFilesSchema = z.object({
  label: z.string().min(1),
  extensions: z.array(z.string().min(1)),
  allowMultiple: z.boolean().optional(),
  /** Pick a directory instead of file(s) — grants recursive read of its contents. */
  directory: z.boolean().optional(),
  /** Pre-navigate the native picker to this absolute path. */
  defaultPath: z.string().optional(),
  /** Guidance shown in the native picker (macOS). */
  message: z.string().optional()
})
export type ImportPickFilesInput = z.infer<typeof ImportPickFilesSchema>

export interface ImportPickFilesResult {
  canceled: boolean
  filePaths: string[]
}

export const ImportStartSchema = z.object({
  importId: z.string().min(1),
  importerId: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)),
  options: z.record(z.string(), z.unknown()).optional()
})
export type ImportStartInput = z.infer<typeof ImportStartSchema>

export const ImportCancelSchema = z.object({ importId: z.string().min(1) })
export type ImportCancelInput = z.infer<typeof ImportCancelSchema>

/**
 * Skipped items collapsed by the reason they were skipped, so the summary can
 * say *why* instead of only how many (e.g. locked Apple Notes notes).
 */
export interface ImportSkippedGroup {
  /** Translated through the same code → key map as preview warnings. */
  reason: ImportPreviewMessage
  count: number
}

/**
 * Distinct *free-text* skip reasons kept per run — a reason can embed a varying
 * error string (one per rejected attachment extension, say), so the payload
 * needs a bound. Coded reasons are exempt: their space is already bounded by
 * IMPORT_MESSAGE_CODES, and capping them would let free text crowd out the
 * line that explains the skip. Items beyond the cap are still counted in
 * `skipped`.
 */
export const MAX_SKIPPED_REASON_GROUPS = 8

export interface ImportSummaryResult {
  imported: number
  attachments: number
  skipped: number
  failed: { item: string; error: string }[]
  /** Absent on payloads from builds before grouped skip reasons landed. */
  skippedReasons?: ImportSkippedGroup[]
}

export interface ImportStartResult {
  success: true
  summary: ImportSummaryResult
}

/** The IPC layer resolves a thrown importer as this envelope (it does not reject). */
export interface ImportErrorResult {
  success: false
  error: string
}

export type ImportStartResponse = ImportStartResult | ImportErrorResult

export type ImportPhase = 'scanning' | 'importing' | 'done'

export interface ImportProgressEvent {
  importId: string
  phase: ImportPhase
  /** Plain strings stay accepted so a payload from an older build keeps rendering. */
  status: string | ImportMessage
  imported: number
  attachments: number
  skipped: number
  failed: number
  completed: number
  total: number
  done: boolean
  summary?: ImportSummaryResult
}

// ============================================================================
// Importer metadata (registry-derived Settings catalog)
// ============================================================================

export interface ImporterMeta {
  id: string
  name: string
  descriptionKey: string
  fileSpec: {
    label: string
    extensions: string[]
    allowMultiple: boolean
    /**
     * Pick a directory instead of file(s). Selecting a folder in the native
     * panel grants the app recursive read access to it (macOS user-consent
     * exception), so protected locations like the Apple Notes container —
     * including attachments — become readable without Full Disk Access.
     */
    directory?: boolean
    /**
     * Offer a folder picker alongside the file picker (the dialog renders a
     * second button — Electron cannot combine both in one native panel).
     */
    allowDirectory?: boolean
    /**
     * i18n key for the folder-picker button's label. Directory importers differ
     * in what they ask for, so the copy belongs to the importer; absent → the
     * dialog's generic "Choose folder…".
     */
    chooseLabelKey?: string
    /**
     * i18n key for the guidance shown above the picker button. Absent → no
     * hint, rather than another importer's instructions.
     */
    folderHintKey?: string
    /** Pre-navigate the picker to this absolute path. */
    defaultPath?: string
    /** Guidance shown inside the native picker. */
    message?: string
  }
  supportsPreview: boolean
  /**
   * Imports from a connected account instead of picked files; the dialog
   * renders the importer's own panel (sign-in + source picker) in place of the
   * file picker. Absent on payloads from older builds → treated as false.
   */
  accountBased?: boolean
}

// ============================================================================
// Optional preview (no writes) — importers that support it report what would
// be imported before the user commits.
// ============================================================================

/**
 * A warning/error described by an importer. `@memry/importers` cannot depend on
 * the i18n runtime, so it emits a stable `code` (plus the values it
 * interpolates) and keeps the English text in `message`. The renderer maps
 * `code` → i18n key at display time and renders `message` verbatim when the
 * code is absent or unknown.
 */
export interface ImportMessage {
  code?: string
  message: string
  params?: Record<string, string | number>
}

/** Plain strings stay accepted so untranslated producers keep rendering. */
export type ImportPreviewMessage = string | ImportMessage

export interface ImportPreviewGroup {
  /** File name / project name the group represents. */
  label: string
  /** Labeled counts; the renderer resolves each labelKey via i18n. */
  counts: { labelKey: string; value: number }[]
  sampleTitles?: string[]
  warnings?: ImportPreviewMessage[]
  /** Set when this group could not be parsed; other groups still preview. */
  error?: ImportPreviewMessage
}

export interface ImportPreview {
  groups: ImportPreviewGroup[]
}

export const ImportPreviewSchema = z.object({
  importId: z.string().min(1),
  importerId: z.string().min(1),
  sourcePaths: z.array(z.string().min(1)),
  options: z.record(z.string(), z.unknown()).optional()
})
export type ImportPreviewInput = z.infer<typeof ImportPreviewSchema>

export interface ImportPreviewSuccess {
  success: true
  preview: ImportPreview
}

export type ImportPreviewResponse = ImportPreviewSuccess | ImportErrorResult

// ============================================================================
// Apple Notes — folder tree for the dialog's folder picker. Apple Notes is
// file-picked, not account-based: the user grants access to the
// `group.com.apple.notes` container first, then this channel reads the folder
// tree from that path so the import can be narrowed. The run itself still goes
// over `import:start`, with the picked folders in `options`.
// ============================================================================

export const AppleNotesImportChannels = {
  invoke: {
    /** Account → folder → subfolder tree with note counts (no note bodies read). */
    FOLDERS: 'import:apple-notes:folders',
    /** Checks a Notes password against the locked notes' keys (no bodies decrypted). */
    CHECK_UNLOCK: 'import:apple-notes:check-unlock'
  }
} as const

export const AppleNotesFoldersSchema = z.object({
  /** The picked `group.com.apple.notes` folder, or a NoteStore.sqlite file. */
  sourcePath: z.string().min(1)
})
export type AppleNotesFoldersInput = z.infer<typeof AppleNotesFoldersSchema>

export const AppleNotesCheckUnlockSchema = z.object({
  sourcePath: z.string().min(1),
  /** Used for this one check and discarded; never stored or logged. */
  password: z.string().min(1)
})
export type AppleNotesCheckUnlockInput = z.infer<typeof AppleNotesCheckUnlockSchema>

export interface AppleNotesCheckUnlockResult {
  /** Locked notes the password unlocks. */
  unlocked: number
  /** Locked notes in the library. */
  total: number
}

export interface AppleNotesFolderNode {
  /** ICFolder identifier — the stable key the import selection travels as. */
  id: string
  title: string
  /** Notes directly in this folder. */
  noteCount: number
  /** Notes in this folder and every subfolder. */
  totalNoteCount: number
  children: AppleNotesFolderNode[]
}

export interface AppleNotesAccountNode {
  /** ICAccount identifier, falling back to its primary key — render key only. */
  id: string
  /** Empty when the folders' account row is missing (the picker then shows no header). */
  name: string
  folders: AppleNotesFolderNode[]
}

export interface AppleNotesFoldersResult {
  accounts: AppleNotesAccountNode[]
  /** Notes that sit outside any folder; selectable as their own row. */
  unfiledNoteCount: number
  /** Password-protected notes; the dialog offers a password field when above zero. */
  lockedNoteCount: number
}

/**
 * Shape of `ImportStartInput.options` for the Apple Notes importer. Both fields
 * absent (or an empty `folderIds` with no unfiled notes) means import
 * everything, so older callers and a failed folder scan keep working.
 */
export interface AppleNotesImportOptionsInput {
  /** ICFolder identifiers to import; omit to import every folder. */
  folderIds?: string[]
  /** Also import notes that sit outside any folder (default: with everything). */
  includeUnfiledNotes?: boolean
  /** Notes password for locked notes; absent keeps them skipped. Held in memory only. */
  notesPassword?: string
}

// ============================================================================
// OneNote (account-based importer) — Microsoft sign-in + notebook tree for the
// dialog's OneNote panel. The import itself still runs over the generic
// `import:start` channel, with the panel's choices in `options`.
// ============================================================================

export const OneNoteImportChannels = {
  invoke: {
    /** Current auth state (configured / connected / signed-in account). */
    STATUS: 'import:onenote:status',
    /** Run the interactive Microsoft sign-in (system browser + loopback). */
    CONNECT: 'import:onenote:connect',
    /** Forget the connected Microsoft account (local token wipe). */
    DISCONNECT: 'import:onenote:disconnect',
    /** Notebook → section group → section tree for the section picker. */
    NOTEBOOKS: 'import:onenote:notebooks'
  }
} as const

export interface OneNoteAccountInfo {
  name: string
  email: string
}

export interface OneNoteAuthStatusResult {
  /** False until the install has an Azure client id (`ONENOTE_CLIENT_ID`). */
  configured: boolean
  connected: boolean
  account: OneNoteAccountInfo | null
}

export interface OneNoteSectionSummaryDto {
  id: string
  displayName: string
}

export interface OneNoteSectionGroupDto {
  id: string
  displayName: string
  sections: OneNoteSectionSummaryDto[]
  sectionGroups: OneNoteSectionGroupDto[]
}

export interface OneNoteNotebookDto {
  id: string
  displayName: string
  sections: OneNoteSectionSummaryDto[]
  sectionGroups: OneNoteSectionGroupDto[]
}

export interface OneNoteNotebooksResult {
  notebooks: OneNoteNotebookDto[]
}

/** Shape of `ImportStartInput.options` for the OneNote importer. */
export interface OneNoteImportOptionsInput {
  /** Section ids to import; omit to import every section. */
  sectionIds?: string[]
  /** Also save attachment types Memry cannot embed natively (default false). */
  includeIncompatibleAttachments?: boolean
  /** Skip pages a previous OneNote run already imported (default true). */
  skipPreviouslyImported?: boolean
}

// ============================================================================
// Readwise (account-based importer, #1408 D1/D2) — pasted access token, the
// root folder, folder layout, per-category switches and cadence. The token goes
// to secret storage and never comes back over IPC. The backfill itself runs
// over the generic `import:start` channel.
// ============================================================================

export const ReadwiseImportChannels = {
  invoke: {
    /** Connection state, the synced options and the last run's outcome. */
    STATUS: 'import:readwise:status',
    /** Verify a pasted token against Readwise, then store it. */
    CONNECT: 'import:readwise:connect',
    /** Delete the token. Every note stays (D9). */
    DISCONNECT: 'import:readwise:disconnect',
    /** Ask the pulling device for a run now. */
    SYNC_NOW: 'import:readwise:sync-now',
    /** Change the synced options. */
    SET_OPTIONS: 'import:readwise:set-options'
  }
} as const

export const READWISE_CATEGORIES = [
  'books',
  'articles',
  'tweets',
  'podcasts',
  'supplementals'
] as const
export type ReadwiseCategory = (typeof READWISE_CATEGORIES)[number]

export const READWISE_FOLDER_LAYOUTS = ['by-category', 'flat'] as const
export type ReadwiseFolderLayout = (typeof READWISE_FOLDER_LAYOUTS)[number]

export const READWISE_CADENCES = ['manual', 'hourly', 'daily'] as const
export type ReadwiseCadence = (typeof READWISE_CADENCES)[number]

export interface ReadwiseOptions {
  rootFolder: string
  folderLayout: ReadwiseFolderLayout
  categories: Record<ReadwiseCategory, boolean>
  cadence: ReadwiseCadence
}

/** D3: supplementals are listed and off. D1/#1416: hourly by default. */
export const READWISE_OPTIONS_DEFAULTS: ReadwiseOptions = {
  rootFolder: 'Readwise',
  folderLayout: 'by-category',
  categories: {
    books: true,
    articles: true,
    tweets: true,
    podcasts: true,
    supplementals: false
  },
  cadence: 'hourly'
}

export const ReadwiseConnectSchema = z.object({
  /** Verified, then stored in secret storage. Never persisted anywhere else. */
  token: z.string().trim().min(1)
})
export type ReadwiseConnectInput = z.infer<typeof ReadwiseConnectSchema>

/** A vault-relative folder path: no leading slash, no `.` or `..` segment. */
export const ReadwiseRootFolderSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/^\/+|\/+$/g, ''))
  .refine(
    (value) =>
      value.length > 0 &&
      value.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
    'Invalid folder path'
  )

export const ReadwiseSetOptionsSchema = z.object({
  rootFolder: ReadwiseRootFolderSchema.optional(),
  folderLayout: z.enum(READWISE_FOLDER_LAYOUTS).optional(),
  categories: z
    .object({
      books: z.boolean().optional(),
      articles: z.boolean().optional(),
      tweets: z.boolean().optional(),
      podcasts: z.boolean().optional(),
      supplementals: z.boolean().optional()
    })
    .optional(),
  cadence: z.enum(READWISE_CADENCES).optional()
})
export type ReadwiseSetOptionsInput = z.infer<typeof ReadwiseSetOptionsSchema>

export interface ReadwiseStatusResult {
  connected: boolean
  options: ReadwiseOptions
  /** ISO time of the last completed run on this device, or null. */
  lastSyncAt: string | null
  /** The last run failed in a way the user must fix, such as a revoked token. */
  needsAttention: boolean
  /**
   * A run has completed on this device (the cursor is set). False means the
   * next run is the first import, which the dialog previews first (#1413).
   */
  hasImported: boolean
}

/**
 * Count keys of a Readwise preview group (`ImportPreviewGroup.counts[].labelKey`).
 * The group's `label` is the category, and the first-import preview reads the
 * counts back by these keys.
 */
export const READWISE_PREVIEW_COUNT_KEYS = {
  books: 'import.preview.readwise.books',
  highlights: 'import.preview.readwise.highlights'
} as const
