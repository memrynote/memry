/**
 * Data shapes for the NotePlan import transform.
 *
 * Pure data — no electron / fs / db dependencies. Note that
 * `markdown/types.ts` in this same package already exports a type called
 * `NotePlan` (meaning "plan for one note"), so nothing here may reuse that
 * name.
 */

/** Which top-level NotePlan directory a file came from. */
export type NotePlanArea = 'calendar' | 'notes' | 'archive'

/** One file found during the scan. */
export interface ScannedFile {
  /** Path relative to the *area* directory, e.g. `10 - Projects/x.txt`. */
  relPath: string
  absPath: string
  /** The folder the user selected — bounds asset resolution. */
  rootDir: string
  area: NotePlanArea
}

/** A file that will become a note. */
export interface PlannedNote {
  absPath: string
  rootDir: string
  /** Filename-derived fallback; the orchestrator prefers the body's H1. */
  title: string
  /** Vault folder, e.g. `NotePlan/10 - Projects`. */
  vaultFolder: string
}

/** A file that will become a journal entry. */
export interface PlannedJournal {
  absPath: string
  rootDir: string
  /** ISO `YYYY-MM-DD`. */
  date: string
}

export interface SkippedFile {
  item: string
  reason: string
}

export interface NotePlanImportPlan {
  notes: PlannedNote[]
  journals: PlannedJournal[]
  skipped: SkippedFile[]
}
