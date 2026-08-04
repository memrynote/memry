import type { ImportMessage } from '../messages'

/** A single row of a Raindrop.io CSV bookmark export. */
export interface RaindropRow {
  id: string
  title: string
  note: string
  excerpt: string
  url: string
  /** Raindrop collection name ("Unsorted" when uncategorised). */
  folder: string
  tags: string[]
  /** ISO-8601 creation timestamp. */
  created: string
  /** Hero image URL (often an expiring CDN link). */
  cover: string
  highlights: string
  favorite: boolean
}

/** A bookmark mapped to an inbox `link` item, ready for `insertItemWithTags`. */
export interface InboxItemPlan {
  title: string
  content: string | null
  sourceUrl: string
  createdAt: string
  tags: string[]
  metadata: {
    url: string
    excerpt: string
    note: string
    folder: string
    favorite: boolean
    heroImage: string
    highlights: string
  }
}

export interface ImportWarning extends ImportMessage {
  row?: number
}

export interface RaindropImportPlan {
  items: InboxItemPlan[]
  stats: { bookmarks: number; withTags: number; skipped: number }
  sampleTitles: string[]
  warnings: ImportWarning[]
}
