import { EPOCH, imageTarget } from './highlights.ts'
import { folderUnder, type NotePlan } from './plan-note.ts'
import { sealSection } from './section.ts'
import { bookTagNames, escapeParagraphs } from './text.ts'
import type { FolderLayout, SavedImages } from './types.ts'

/**
 * A top-level Reader v3 document, the fields the mapper reads. Every field a
 * payload may leave out or null is optional (D11).
 */
export interface ReaderDocument {
  id: string
  url?: string | null
  title?: string | null
  author?: string | null
  source?: string | null
  category?: string | null
  location?: string | null
  /** An object keyed by tag name, as Reader sends it. */
  tags?: Record<string, { name?: string | null }> | null
  site_name?: string | null
  word_count?: number | null
  published_date?: string | number | null
  summary?: string | null
  image_url?: string | null
  source_url?: string | null
  notes?: string | null
  parent_id?: string | null
}

/** Documents without highlights go into this subfolder of the root (D3). */
const READER_FOLDER = 'Reader'

export interface PlanReaderNoteOptions {
  root: string
  folderLayout: FolderLayout
  images?: SavedImages
  /**
   * The full article text as markdown, converted from `html_content` by the
   * caller. Written once, below the section, when the note is created (D11).
   */
  fullText?: string | null
  /**
   * Ids of Reader documents that already have a v2 book (`external_id`). Their
   * highlights render into that book's note, so the document gets no second
   * note (D11).
   */
  bookExternalIds?: ReadonlySet<string>
}

export interface ReaderNotePlan extends NotePlan {
  /** Markdown for below the section, for a new note only. Null when none. */
  fullText: string | null
}

export function readerDocumentUrl(document: ReaderDocument): string {
  return document.url || `https://read.readwise.io/read/${document.id}`
}

/** `YYYY-MM-DD` for a Reader `published_date`, which comes as a date string or a Unix time. */
function publishedDay(value: ReaderDocument['published_date']): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') {
    const ms = value < 1e11 ? value * 1000 : value
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10)
  }
  const trimmed = value.trim()
  return trimmed || null
}

/**
 * What a saved Reader document's note should look like, in the shape of
 * `planNote` so the writer needs no second path (D11). Null for a document that
 * never becomes a note: a child (`parent_id` set, a highlight or note made in
 * Reader), a `feed` item, or one whose highlights already live in a v2 book's
 * note.
 *
 * Frontmatter holds only fields that stay put. `location` and
 * `reading_progress` change while the user reads, so they are left out (D4).
 */
export function planReaderNote(
  document: ReaderDocument,
  options: PlanReaderNoteOptions
): ReaderNotePlan | null {
  if (document.parent_id) return null
  if (document.location === 'feed') return null
  if (options.bookExternalIds?.has(document.id)) return null

  const images = options.images ?? new Map<string, string>()
  const coverUrl = document.image_url || null
  const savedCover = coverUrl ? images.get(coverUrl) : undefined
  const isArticle = (document.category ?? '').trim().toLowerCase() === 'article'

  const frontmatter: Record<string, unknown> = {}
  const set = (key: string, value: string | number | null | undefined): void => {
    const trimmed = typeof value === 'string' ? value.trim() : value
    if (trimmed !== undefined && trimmed !== null && trimmed !== '') frontmatter[key] = trimmed
  }
  set('author', document.author)
  set('category', document.category?.trim().toLowerCase())
  set('source', document.source)
  set('source_url', document.source_url)
  frontmatter.readwise_url = readerDocumentUrl(document)
  const tags = bookTagNames(
    Object.entries(document.tags ?? {}).map(([key, tag]) => ({ name: tag.name || key }))
  )
  if (tags.length > 0) frontmatter.tags = tags
  set('site_name', document.site_name)
  set('published_date', publishedDay(document.published_date))
  set('word_count', document.word_count)
  if (isArticle && savedCover !== undefined) frontmatter.cover = savedCover

  const parts: string[] = []
  if (!isArticle && savedCover !== undefined) parts.push(`![](${imageTarget(savedCover)})`)
  const documentNote = escapeParagraphs(document.notes ?? '')
  if (documentNote) parts.push(`## Document note\n\n${documentNote}`)
  const summary = escapeParagraphs(document.summary ?? '')
  if (summary) parts.push(`## Summary\n\n${summary}`)
  parts.push('## Highlights')

  return {
    folder: folderUnder(options.root, options.folderLayout, READER_FOLDER),
    title: (document.title ?? '').trim() || 'Untitled',
    frontmatter,
    section: sealSection(parts.join('\n\n'), EPOCH),
    last: EPOCH,
    imageUrls: coverUrl ? [coverUrl] : [],
    fullText: options.fullText?.trim() || null
  }
}
