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

export interface ImportSummaryResult {
  imported: number
  attachments: number
  skipped: number
  failed: { item: string; error: string }[]
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
    /** Pre-navigate the picker to this absolute path. */
    defaultPath?: string
    /** Guidance shown inside the native picker. */
    message?: string
  }
  supportsPreview: boolean
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
