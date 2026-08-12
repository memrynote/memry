import type { ImportMessage, ImportPreview } from '@memry/contracts/import-channels'

export interface ImportFileSpec {
  label: string
  extensions: string[]
  allowMultiple: boolean
  /** Pick a directory; selecting it grants recursive read of its contents. */
  directory?: boolean
  /**
   * Offer a folder picker *in addition to* the file picker. Electron cannot
   * show one native panel that accepts both on Windows/Linux (it silently
   * degrades to directory-only), so the dialog renders a second button.
   */
  allowDirectory?: boolean
  /**
   * i18n key for the folder-picker button's label. Directory importers differ
   * in what they ask for, so the copy belongs to the importer; absent → the
   * dialog's generic "Choose folder…".
   */
  chooseLabelKey?: string
  /**
   * i18n key for the guidance shown above the picker button. Absent → no hint,
   * rather than another importer's instructions.
   */
  folderHintKey?: string
  /** Pre-navigate the native picker to this absolute path. */
  defaultPath?: string
  /** Guidance shown inside the native picker. */
  message?: string
}

export interface ImportProgress {
  importId: string
  phase: 'scanning' | 'importing' | 'done'
  /** Plain strings stay accepted so a payload from an older build keeps rendering. */
  status: string | ImportMessage
  imported: number
  attachments: number
  skipped: number
  failed: number
  completed: number
  total: number
  done: boolean
  summary?: ImportSummary
}

export interface ImportSummary {
  imported: number
  attachments: number
  skipped: number
  failed: { item: string; error: string }[]
}

export interface ImportContext {
  status(message: string | ImportMessage): void
  setPhase(phase: ImportProgress['phase']): void
  reportProgress(completed: number, total: number): void
  reportImported(): void
  reportAttachment(): void
  reportSkipped(item: string, reason?: string): void
  reportFailed(item: string, error?: unknown): void
  isCancelled(): boolean
  readonly signal: AbortSignal
  toSummary(): ImportSummary
}

export interface ImportInput {
  sourcePaths: string[]
  options?: Record<string, unknown>
}

export interface Importer {
  id: string
  name: string
  descriptionKey: string
  fileSpec: ImportFileSpec
  /**
   * Imports from a connected account instead of picked files (the dialog shows
   * the importer's own panel — e.g. OneNote's sign-in + notebook picker —
   * rather than the native file picker).
   */
  accountBased?: boolean
  preview?(input: ImportInput, signal: AbortSignal): Promise<ImportPreview>
  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary>
}

export type { ImportPreview, ImportPreviewGroup } from '@memry/contracts/import-channels'
