/** Extracted data from one Apple Journal HTML file before writing. */
export interface JournalEntryInput {
  /** ISO date string parsed from `.pageHeader`, e.g. "2024-11-03". */
  date: string | null
  /** Markdown body (paragraphs only, no reflection). */
  bodyMarkdown: string
  /** Reflection prompt text, if present. */
  reflection: string | null
  /** Raw label strings collected from asset grid overlay elements. */
  overlayValues: string[]
  /** Original filename stem (no extension), used as title fallback. */
  filenameStem: string
}

/** Assembled plan for one journal entry — what to pass to createNote. */
export interface JournalEntryPlan {
  title: string
  folder: string
  content: string
  properties: Record<string, unknown>
  /** ISO date string for the `created` field, if a date was parsed. */
  created: string | undefined
}
