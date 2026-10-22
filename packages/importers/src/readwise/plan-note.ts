import {
  imageHighlightUrl,
  imageTarget,
  isLiveHighlight,
  newestCreatedAt,
  renderHighlights
} from './highlights.ts'
import { sealSection } from './section.ts'
import { bookTagNames, escapeParagraphs } from './text.ts'
import {
  READWISE_CATEGORIES,
  type CategorySwitches,
  type FolderLayout,
  type ReadwiseBook,
  type ReadwiseCategory,
  type SavedImages
} from './types.ts'

/** Which categories sync when the user has not chosen (D3). */
export const DEFAULT_CATEGORY_SWITCHES: Record<ReadwiseCategory, boolean> = {
  books: true,
  articles: true,
  tweets: true,
  podcasts: true,
  supplementals: false
}

const CATEGORY_FOLDERS: Record<ReadwiseCategory, string> = {
  books: 'Books',
  articles: 'Articles',
  tweets: 'Tweets',
  podcasts: 'Podcasts',
  supplementals: 'Supplementals'
}

const OTHER_FOLDER = 'Other'

export interface PlanNoteOptions {
  root: string
  folderLayout: FolderLayout
  categories: CategorySwitches
  /** The pulling device's IANA time zone, for the date of each highlight. */
  timeZone: string
  images?: SavedImages
}

export interface NotePlan {
  folder: string
  title: string
  /** Written once, when the note is created (D4). */
  frontmatter: Record<string, unknown>
  /** The whole section, markers included. */
  section: string
  /** The `last` in the section's end marker. */
  last: string
  /** Remote images the plan needs, for the writer to save (D14). */
  imageUrls: string[]
}

/** A book deleted in Readwise. The note stays and the book stops syncing (D9). */
export interface DeletedBookPlan {
  deleted: true
  readwiseUrl: string
}

function isKnownCategory(category: string): category is ReadwiseCategory {
  return (READWISE_CATEGORIES as readonly string[]).includes(category)
}

export function bookUrl(book: ReadwiseBook): string {
  return book.readwise_url || `https://readwise.io/bookreview/${book.user_book_id}`
}

function folderFor(category: string, root: string, layout: FolderLayout): string {
  const base = root.replace(/\/+$/, '')
  if (layout === 'flat') return base
  const sub = isKnownCategory(category) ? CATEGORY_FOLDERS[category] : OTHER_FOLDER
  return base ? `${base}/${sub}` : sub
}

/**
 * What a book's note should look like, from the full book (D7): never pass
 * the changed-highlights-only entry of an `updatedAfter` export, or the
 * section would drop every other highlight. Null for a book to skip, one in a
 * category the user switched off.
 */
export function planNote(
  book: ReadwiseBook,
  options: PlanNoteOptions
): NotePlan | DeletedBookPlan | null {
  if (book.is_deleted) return { deleted: true, readwiseUrl: bookUrl(book) }

  const category = (book.category ?? '').trim().toLowerCase()
  const enabled = isKnownCategory(category)
    ? (options.categories[category] ?? DEFAULT_CATEGORY_SWITCHES[category])
    : true
  if (!enabled) return null

  const images = options.images ?? new Map<string, string>()
  const highlights = (book.highlights ?? []).filter(isLiveHighlight)
  const imageUrls: string[] = []
  const coverUrl = book.cover_image_url || null
  if (coverUrl) imageUrls.push(coverUrl)
  for (const highlight of highlights) {
    const url = imageHighlightUrl(highlight)
    if (url !== null && !imageUrls.includes(url)) imageUrls.push(url)
  }

  const savedCover = coverUrl ? images.get(coverUrl) : undefined
  const isArticle = category === 'articles'

  const frontmatter: Record<string, unknown> = {}
  const set = (key: string, value: string | null | undefined): void => {
    const trimmed = value?.trim()
    if (trimmed) frontmatter[key] = trimmed
  }
  set('author', book.author)
  set('category', category)
  set('source', book.source)
  set('source_url', book.source_url)
  frontmatter.readwise_url = bookUrl(book)
  const tags = bookTagNames(book.book_tags)
  if (tags.length > 0) frontmatter.tags = tags
  if (isArticle && savedCover !== undefined) frontmatter.cover = savedCover

  const parts: string[] = []
  if (!isArticle && savedCover !== undefined) parts.push(`![](${imageTarget(savedCover)})`)
  const documentNote = escapeParagraphs(book.document_note ?? '')
  if (documentNote) parts.push(`## Document note\n\n${documentNote}`)
  const summary = escapeParagraphs(book.summary ?? '')
  if (summary) parts.push(`## Summary\n\n${summary}`)
  const { markdown, rendered, missing } = renderHighlights(highlights, {
    timeZone: options.timeZone,
    images
  })
  parts.push(markdown ? `## Highlights\n\n${markdown}` : '## Highlights')
  const last = newestCreatedAt(rendered, missing, '')

  return {
    folder: folderFor(category, options.root, options.folderLayout),
    title: (book.readable_title || book.title || '').trim() || 'Untitled',
    frontmatter,
    section: sealSection(parts.join('\n\n'), last),
    last,
    imageUrls
  }
}

export function isDeletedBookPlan(
  plan: NotePlan | DeletedBookPlan | null
): plan is DeletedBookPlan {
  return plan !== null && 'deleted' in plan
}
