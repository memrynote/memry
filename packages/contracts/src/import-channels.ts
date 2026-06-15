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
    CANCEL: 'import:cancel'
  },
  events: {
    /** Streaming progress for a run, keyed by importId. */
    PROGRESS: 'import:progress'
  }
} as const

export const ImportPickFilesSchema = z.object({
  label: z.string().min(1),
  extensions: z.array(z.string().min(1)),
  allowMultiple: z.boolean().optional()
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
  status: string
  imported: number
  attachments: number
  skipped: number
  failed: number
  completed: number
  total: number
  done: boolean
  summary?: ImportSummaryResult
}
