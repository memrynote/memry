import { eq } from 'drizzle-orm'
import { net } from 'electron'
import {
  hashSectionBody,
  imageHighlightUrl,
  linkedHighlightIds,
  planAppend,
  planNote,
  readSection,
  writeEndMarker,
  type EndMarker,
  type NotePlan,
  type PlanNoteOptions,
  type ReadwiseBook
} from '@memry/importers/readwise'
import { noteProperties } from '@memry/db-schema/schema/notes-cache'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { createImportedNote } from '../import/_shared/imported-note'
import { updateNoteCommand } from '../notes/domain'
import { getCrdtProvider } from '../sync/crdt-provider'
import { wasRecentNetworkUpdate } from '../sync/crdt-writeback'
import { getStatus } from '../vault'
import { getNoteById, type Note } from '../vault/notes'
import type { RemoteFetch } from '../vault/remote-attachment'
import { resolveImages } from './images'
import { completeLink, getLinkForBook, markLinkState, upsertLink } from './links-repository'
import { parseReadwiseUrl } from './rebuild-links'
import { addRetry, removeRetry } from './sync-state'

const log = createLogger('ReadwiseWriter')

export interface UpsertOptions {
  /** Re-import (D16): rewrite the section from the full book even when it is touched. */
  reset?: boolean
  /**
   * A command the user started (D16). It writes into a note that is open in
   * an editor, because the user asked for the change. `reset` implies it.
   */
  userInitiated?: boolean
  /**
   * Restore a book whose link is `note-deleted` (D16): ignore the link's
   * state and its note id, adopt a note that already names the book, or
   * create the note the way a new book gets one, then link it again.
   */
  restore?: boolean
  /**
   * The book holds only the highlights that changed (D7, step 2). Such a
   * payload can append to a touched section, and nothing else: a new note or
   * an untouched section needs the whole book, so the writer answers
   * `needs-full` and writes nothing.
   */
  incremental?: boolean
  /** The options `plan` was made with. The writer plans again once images are saved. */
  planOptions: PlanNoteOptions
  fetch?: RemoteFetch
}

export type UpsertOutcome =
  | { status: 'created' | 'updated' | 'appended' | 'unchanged'; noteId: string }
  /** `note-deleted` and `source-deleted` links do nothing (D9). */
  | { status: 'skipped'; reason: 'note-deleted' | 'source-deleted' | 'busy'; noteId?: string }
  | { status: 'failed'; reason: string }
  /** `incremental` only: the write needs the book's full highlight list. Nothing was written. */
  | { status: 'needs-full' }

/**
 * The one write path from a Readwise book into the vault (D5, D6). `plan` is
 * `planNote(book, …)` for the full book. Never rewrites text the user may have
 * touched, never writes frontmatter after creation (D4), and writes nothing
 * when the bytes would not change.
 *
 * Failures never throw: the book goes on the retry list and the outcome says
 * why, so one locked folder cannot stop a run.
 */
/** One write at a time per book: two overlapping runs would both create the note, or overwrite each other's append. */
const inflight = new Map<number, Promise<unknown>>()

export async function upsertReadwiseNote(
  book: ReadwiseBook,
  plan: NotePlan,
  options: UpsertOptions
): Promise<UpsertOutcome> {
  const previous = inflight.get(book.user_book_id) ?? Promise.resolve()
  const run = previous.then(() => upsertOne(book, plan, options))
  const settled = run.catch(() => undefined)
  inflight.set(book.user_book_id, settled)
  try {
    return await run
  } finally {
    if (inflight.get(book.user_book_id) === settled) inflight.delete(book.user_book_id)
  }
}

async function upsertOne(
  book: ReadwiseBook,
  plan: NotePlan,
  options: UpsertOptions
): Promise<UpsertOutcome> {
  try {
    const outcome = await upsert(book, plan, options)
    if (outcome.status === 'needs-full') return outcome
    if (outcome.status === 'skipped' && outcome.reason === 'busy') {
      addRetry(getDatabase(), book.user_book_id, 'note-open')
    } else {
      removeRetry(getDatabase(), book.user_book_id)
    }
    return outcome
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn('A Readwise book could not be written', { bookId: book.user_book_id, error })
    try {
      addRetry(getDatabase(), book.user_book_id, reason)
    } catch (retryError) {
      log.error('A failed Readwise book could not be put on the retry list', { retryError })
    }
    return { status: 'failed', reason }
  }
}

async function upsert(
  book: ReadwiseBook,
  plan: NotePlan,
  options: UpsertOptions
): Promise<UpsertOutcome> {
  const db = getDatabase()
  const link = getLinkForBook(db, book.user_book_id, book.external_id)
  if (link)
    completeLink(db, link, {
      readwiseBookId: book.user_book_id,
      readerDocumentId: book.external_id
    })
  if (link && link.state !== 'linked' && !options.restore) {
    return { status: 'skipped', reason: link.state }
  }

  let note: Note | null = null
  if (options.restore) {
    note = await findBookNote(book, plan)
    if (note) {
      upsertLink(db, {
        readwiseBookId: book.user_book_id,
        readerDocumentId: book.external_id,
        noteId: note.id
      })
      return { status: 'unchanged', noteId: note.id }
    }
  } else if (link) {
    note = await getNoteById(link.noteId)
    if (!note) {
      // A missing row also means "not indexed yet". `note-deleted` is sticky
      // (D9), so never mark it while the vault is still indexing.
      if (getStatus().isIndexing) throw new Error('The vault is still indexing')
      markLinkState(db, { readwiseBookId: book.user_book_id }, 'note-deleted')
      return { status: 'skipped', reason: 'note-deleted' }
    }
  } else {
    // The book's own note, or the Reader note of its document (D11).
    note = await findBookNote(book, plan)
    if (note) {
      upsertLink(db, {
        readwiseBookId: book.user_book_id,
        readerDocumentId: book.external_id,
        noteId: note.id
      })
    }
  }

  const fetch = options.fetch ?? ((url: string) => net.fetch(url))
  if (!note) {
    return options.incremental ? { status: 'needs-full' } : createNote(book, plan, options, fetch)
  }

  const section = readSection(note.content)
  if (options.incremental && !options.reset && section.found && section.untouched) {
    // An open note waits for the next run, so skip the full fetch for it (D6).
    return isBusy(note.id)
      ? { status: 'skipped', reason: 'busy', noteId: note.id }
      : { status: 'needs-full' }
  }
  if (options.reset) return resetSection(book, plan, note, options, fetch)
  if (section.found && section.untouched) {
    return rewriteSection(book, plan, note, options, fetch, section.range)
  }
  return appendToNote(book, note, options, fetch)
}

/** The book's own note, or the Reader note of its document (D11). */
async function findBookNote(book: ReadwiseBook, plan: NotePlan): Promise<Note | null> {
  return (
    (await findNoteByReadwiseUrl(plan.frontmatter.readwise_url)) ??
    (book.external_id
      ? await findNoteByReadwiseUrl(`https://read.readwise.io/read/${book.external_id}`)
      : null)
  )
}

/** The note whose `readwise_url` names this book. Lowest id wins, as in `rebuildLinks`. */
export async function findNoteByReadwiseUrl(readwiseUrl: unknown): Promise<Note | null> {
  const wanted = typeof readwiseUrl === 'string' ? parseReadwiseUrl(readwiseUrl) : null
  if (!wanted) return null
  const rows = getIndexDatabase()
    .select({ noteId: noteProperties.noteId, value: noteProperties.value })
    .from(noteProperties)
    .where(eq(noteProperties.name, 'readwise_url'))
    .all()
    .filter((row) => {
      const identity = row.value ? parseReadwiseUrl(row.value) : null
      if (identity === null) return false
      return 'readwiseBookId' in wanted
        ? 'readwiseBookId' in identity && identity.readwiseBookId === wanted.readwiseBookId
        : 'readerDocumentId' in identity && identity.readerDocumentId === wanted.readerDocumentId
    })
    .sort((a, b) => (a.noteId < b.noteId ? -1 : 1))
  for (const row of rows) {
    const note = await getNoteById(row.noteId)
    if (note) return note
  }
  return null
}

/** The note is open in an editor or took a network update moments ago (D6). */
export function isBusy(noteId: string): boolean {
  return Boolean(getCrdtProvider().getDoc(noteId)) || wasRecentNetworkUpdate(noteId)
}

/**
 * The one place a section write reaches `updateNoteCommand`. Images were
 * downloaded since the note was read, so it reads the note again: a body that
 * changed meanwhile, or a note that is open or took a network update, is not
 * written over (D6). A command the user started skips the open check only.
 * `ignoreInlineTags`: a highlight's `#tag` must not reach the note's
 * frontmatter `tags` (D4), and a removed one must not strip a user's tag.
 */
async function commit(
  note: Note,
  content: string,
  options: UpsertOptions,
  status: 'updated' | 'appended'
): Promise<UpsertOutcome> {
  const busy: UpsertOutcome = { status: 'skipped', reason: 'busy', noteId: note.id }
  const latest = await getNoteById(note.id)
  if (!latest || latest.content !== note.content) return busy
  const userStarted = options.userInitiated || options.reset
  if (!userStarted && isBusy(note.id)) return busy
  await updateNoteCommand({ id: note.id, content, ignoreInlineTags: true })
  return { status, noteId: note.id }
}

function replan(
  book: ReadwiseBook,
  plan: NotePlan,
  options: UpsertOptions,
  images: Map<string, string>
): NotePlan {
  if (plan.imageUrls.length === 0) return plan
  const next = planNote(book, { ...options.planOptions, images })
  if (next === null || 'deleted' in next) throw new Error('The book no longer maps to a note')
  return next
}

async function createNote(
  book: ReadwiseBook,
  plan: NotePlan,
  options: UpsertOptions,
  fetch: RemoteFetch
): Promise<UpsertOutcome> {
  const { tags, ...properties } = plan.frontmatter
  const created = await createImportedNote({
    title: plan.title,
    folder: plan.folder,
    properties,
    tags: Array.isArray(tags) ? (tags as string[]) : undefined,
    content: plan.section,
    plainChecklists: true
  })
  upsertLink(getDatabase(), {
    readwiseBookId: book.user_book_id,
    readerDocumentId: book.external_id,
    noteId: created.id
  })

  // Images need the note to exist (D14). Write the section again with them,
  // and an article's cover with it. `cover` goes through `frontmatter`:
  // `propertyPatch` skips it, because the cover key is reserved for the cover
  // band (`isReservedFrontmatterKey`).
  const images = await resolveImages(created.id, created.path, plan.imageUrls, fetch)
  if (images.size > 0) {
    const withImages = replan(book, plan, options, images)
    const cover = withImages.frontmatter.cover
    await updateNoteCommand({
      id: created.id,
      content: replaceSection(created.content, withImages.section),
      ignoreInlineTags: true,
      ...(cover === undefined ? {} : { frontmatter: { cover } })
    })
  }
  return { status: 'created', noteId: created.id }
}

/** Untouched section (D5): render from the full book, write only when the bytes differ. */
async function rewriteSection(
  book: ReadwiseBook,
  plan: NotePlan,
  note: Note,
  options: UpsertOptions,
  fetch: RemoteFetch,
  range: { start: number; end: number }
): Promise<UpsertOutcome> {
  const images = await resolveImages(note.id, note.path, plan.imageUrls, fetch)
  const next = replan(book, plan, options, images)
  const content = note.content.slice(0, range.start) + next.section + note.content.slice(range.end)
  if (content === note.content) return { status: 'unchanged', noteId: note.id }
  return commit(note, content, options, 'updated')
}

const STRAY_MARKERS = /<!--\s*readwise:(?:start|end)[^>]*-->/g

/**
 * Re-import (D16): the section is rendered from the full book and replaces the
 * old one, touched or not. Without a readable pair of markers the new section
 * goes at the end, and what is left of the old one stays as the user's text.
 * Stray marker comments go, or the new pair would sit beside them and the
 * section could never count as untouched again.
 */
async function resetSection(
  book: ReadwiseBook,
  plan: NotePlan,
  note: Note,
  options: UpsertOptions,
  fetch: RemoteFetch
): Promise<UpsertOutcome> {
  const images = await resolveImages(note.id, note.path, plan.imageUrls, fetch)
  const next = replan(book, plan, options, images)
  const section = readSection(note.content)
  const content = section.found
    ? note.content.slice(0, section.range.start) +
      next.section +
      note.content.slice(section.range.end)
    : `${note.content.replace(STRAY_MARKERS, '').trimEnd()}\n\n${next.section}`
  if (content === note.content) return { status: 'unchanged', noteId: note.id }
  return commit(note, content, options, 'updated')
}

export function replaceSection(body: string, section: string): string {
  const read = readSection(body)
  if (!read.found) throw new Error('The new note has no readable Readwise section')
  return body.slice(0, read.range.start) + section + body.slice(read.range.end)
}

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s/

/**
 * An end marker `hash` that does not match the section it closes, so the
 * section stays touched. Derived from the section's own hash, one off.
 */
function touchedHash(build: (hash: string) => string): string {
  const probe = build(hashSectionBody(build('')))
  const read = readSection(probe)
  if (!read.found) return hashSectionBody(probe)
  const next = (Number.parseInt(hashSectionBody(read.text), 16) + 1) >>> 0
  return next.toString(16).padStart(8, '0')
}

/**
 * Touched section (D5), or markers the user removed: never rewrite. Append
 * what is new before the end marker and move `last`. The old hash stays, so
 * the section stays touched.
 */
async function appendToNote(
  book: ReadwiseBook,
  note: Note,
  options: UpsertOptions,
  fetch: RemoteFetch
): Promise<UpsertOutcome> {
  const body = note.content
  const read = readSection(body)

  let endLine: { start: number; end: number } | null = null
  let marker: EndMarker | null = null
  let addMarker = false
  if (read.found) {
    const start = body.lastIndexOf('\n', read.range.end - 1) + 1
    endLine = { start, end: read.range.end }
    marker = read.marker
  } else if (read.end) {
    endLine = read.end.range
    marker = read.end.marker
  } else {
    // Without a readable end marker the state has nowhere to live: a missing
    // one gets a new marker, and an inline or duplicated one is left alone.
    addMarker = read.problem === 'no-end' || read.problem === 'no-start'
  }

  const linkedIds = linkedHighlightIds(body)
  const wanted = (book.highlights ?? [])
    .filter((highlight) => !linkedIds.has(highlight.id))
    .map(imageHighlightUrl)
    .filter((url): url is string => url !== null)
  const images = await resolveImages(note.id, note.path, [...new Set(wanted)], fetch)
  const append = planAppend(book.highlights ?? [], {
    last: marker?.last ?? null,
    noteCreated: note.created.toISOString(),
    linkedIds,
    timeZone: options.planOptions.timeZone,
    images
  })
  if (!append.markdown) return { status: 'unchanged', noteId: note.id }

  let content: string
  if (endLine) {
    const before = body.slice(0, endLine.start).trimEnd()
    const lastLine = before.slice(before.lastIndexOf('\n') + 1)
    const gap = LIST_ITEM.test(lastLine) ? '\n' : '\n\n'
    const endMarker = marker
      ? writeEndMarker({ last: append.last, hash: marker.hash })
      : body.slice(endLine.start, endLine.end)
    content = `${before}${gap}${append.markdown}\n\n${endMarker}${body.slice(endLine.end)}`
  } else if (addMarker) {
    const head = `${body.trimEnd()}\n\n${append.markdown}\n\n`
    const hash = touchedHash(
      (candidate) => head + writeEndMarker({ last: append.last, hash: candidate })
    )
    content = head + writeEndMarker({ last: append.last, hash })
  } else {
    content = `${body.trimEnd()}\n\n${append.markdown}`
  }
  return commit(note, content, options, 'appended')
}
