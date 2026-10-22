/**
 * Readwise v2 export shapes the mapper reads. Only the fields the mapper uses
 * are named, and every field a payload may leave out or null is optional.
 */

export const READWISE_CATEGORIES = [
  'books',
  'articles',
  'tweets',
  'podcasts',
  'supplementals'
] as const

export type ReadwiseCategory = (typeof READWISE_CATEGORIES)[number]

export interface ReadwiseTag {
  id?: number
  name: string
}

export interface ReadwiseHighlight {
  id: number
  is_deleted?: boolean
  is_discard?: boolean
  text?: string | null
  note?: string | null
  tags?: ReadwiseTag[] | null
  location?: number | null
  location_type?: string | null
  highlighted_at?: string | null
  created_at?: string | null
  readwise_url?: string | null
}

export interface ReadwiseBook {
  user_book_id: number
  is_deleted?: boolean
  title?: string | null
  readable_title?: string | null
  author?: string | null
  category?: string | null
  source?: string | null
  source_url?: string | null
  readwise_url?: string | null
  cover_image_url?: string | null
  book_tags?: ReadwiseTag[] | null
  document_note?: string | null
  summary?: string | null
  highlights?: ReadwiseHighlight[] | null
}

/** Whether the user wants a category's books synced (D3). */
export type CategorySwitches = Partial<Record<ReadwiseCategory, boolean>>

export type FolderLayout = 'by-category' | 'flat'

/**
 * Remote image URL → the markdown path of its saved attachment (D14). The
 * writer fills it after downloading. A URL missing from it is left out of the
 * output, so no remote URL reaches a note.
 */
export type SavedImages = ReadonlyMap<string, string>
