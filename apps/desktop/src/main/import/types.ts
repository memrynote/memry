export interface ImportFileSpec {
  label: string
  extensions: string[]
  allowMultiple: boolean
}

export interface ImportProgress {
  importId: string
  phase: 'scanning' | 'importing' | 'done'
  status: string
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
  status(message: string): void
  setPhase(phase: ImportProgress['phase']): void
  reportProgress(completed: number, total: number): void
  reportNote(): void
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
  fileSpec: ImportFileSpec
  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary>
}
