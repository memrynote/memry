import { net } from 'electron'
import {
  isDeletedBookPlan,
  planNote,
  type NotePlan,
  type PlanNoteOptions,
  type ReadwiseBook
} from '@memry/importers/readwise'
import { foldTag } from '@memry/shared/tag-fold'
import { READWISE_CATEGORIES, type ReadwiseDeletedBook } from '@memry/contracts/import-channels'
import { getDatabase } from '../database'
import { getMainI18n } from '../lib/main-i18n'
import { updateNoteCommand } from '../notes/domain'
import { getStatus } from '../vault'
import { getNoteById, type Note } from '../vault/notes'
import type { RemoteFetch } from '../vault/remote-attachment'
import { exportBooks } from './client'
import { resolveImages } from './images'
import {
  getLinkByBookId,
  getLinkByNoteId,
  getLinkByReaderDocumentId,
  listLinks
} from './links-repository'
import { upsertReadwiseNote } from './note-writer'
import { assertThisDevicePulls } from './pulling-device'
import { parseReadwiseUrl } from './rebuild-links'
import { getDocument } from './reader'
import { writeReaderNote } from './reader-notes'
import { getReadwiseToken } from './secrets'
import { readReadwiseOptions } from './settings'

/**
 * The three commands for one book (#1408 D16). They need the token, so each
 * runs on the pulling device only (D8). They go through the same writer and
 * the same owner (`updateNoteCommand`) as a sync run.
 */

export interface BookCommandDeps {
  /** Image downloads (the article cover). Defaults to Electron's `net.fetch`. */
  fetch?: RemoteFetch
}

const FRONTMATTER_FIELDS = ['author', 'category', 'source', 'source_url'] as const

function t(key: string): string {
  return getMainI18n().t(key)
}

/** The gate and the token every command starts with. */
async function requireToken(): Promise<string> {
  const db = getDatabase()
  assertThisDevicePulls(db)
  const { path: vaultPath } = getStatus()
  const token = vaultPath ? await getReadwiseToken(vaultPath) : null
  if (!token) throw new Error(t('errors:importer.readwiseNotConnected'))
  return token
}

/**
 * The options a sync run plans with, with every category on: the user named
 * this book, so a category they switched off for sync must not block it.
 */
function planOptions(): PlanNoteOptions {
  const options = readReadwiseOptions(getDatabase())
  return {
    root: options.rootFolder,
    folderLayout: options.folderLayout,
    categories: Object.fromEntries(READWISE_CATEGORIES.map((category) => [category, true])),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  }
}

async function fetchBooks(token: string, ids: number[]): Promise<Map<number, ReadwiseBook>> {
  const books = new Map<number, ReadwiseBook>()
  for await (const page of exportBooks({ token, ids })) {
    for (const book of page) books.set(book.user_book_id, book)
  }
  return books
}

async function fetchLiveBook(token: string, bookId: number): Promise<ReadwiseBook> {
  const book = (await fetchBooks(token, [bookId])).get(bookId)
  if (!book || book.is_deleted) throw new Error(t('errors:importer.readwiseBookGone'))
  return book
}

function fullPlan(book: ReadwiseBook, options: PlanNoteOptions): NotePlan {
  const plan = planNote(book, options)
  if (plan === null || isDeletedBookPlan(plan)) {
    throw new Error(t('errors:importer.readwiseBookGone'))
  }
  return plan
}

/** The note's Readwise book: its link row, else the `readwise_url` it carries. */
async function linkedBook(noteId: string): Promise<{ bookId: number; note: Note }> {
  const note = await getNoteById(noteId)
  if (!note) throw new Error(t('errors:importer.readwiseNotLinked'))
  const link = getLinkByNoteId(getDatabase(), noteId)
  let bookId = link?.state === 'linked' ? link.readwiseBookId : null
  if (bookId === null && !link) {
    const url = note.properties.readwise_url
    const identity = typeof url === 'string' ? parseReadwiseUrl(url) : null
    if (identity && 'readwiseBookId' in identity) bookId = identity.readwiseBookId
  }
  if (bookId === null) throw new Error(t('errors:importer.readwiseNotLinked'))
  return { bookId, note }
}

function failureOf(outcome: Awaited<ReturnType<typeof upsertReadwiseNote>>): void {
  if (outcome.status === 'failed') throw new Error(outcome.reason)
  if (outcome.status === 'skipped') throw new Error(t('errors:importer.readwiseBookBusy'))
}

/** Re-import (D16): the section is written from the full book, touched or not. */
export async function reimportBook(noteId: string, deps: BookCommandDeps = {}): Promise<void> {
  const token = await requireToken()
  const { bookId } = await linkedBook(noteId)
  const options = planOptions()
  const book = await fetchLiveBook(token, bookId)
  const outcome = await upsertReadwiseNote(book, fullPlan(book, options), {
    reset: true,
    userInitiated: true,
    planOptions: options,
    fetch: deps.fetch
  })
  failureOf(outcome)
}

/**
 * Refresh book info (D16): the Readwise fields go in through `propertyPatch`,
 * an article's cover through `frontmatter` (the cover key is reserved for the
 * cover band, so `propertyPatch` skips it), and the Readwise tags the note
 * lacks through `headerTags.add`. No tag is removed, and the title and path
 * stay. A field Readwise has no value for stays as it is.
 */
export async function refreshBookInfo(noteId: string, deps: BookCommandDeps = {}): Promise<void> {
  const token = await requireToken()
  const { bookId, note } = await linkedBook(noteId)
  const options = planOptions()
  const book = await fetchLiveBook(token, bookId)
  let plan = fullPlan(book, options)

  const coverUrl = book.cover_image_url
  if (plan.frontmatter.category === 'articles' && coverUrl) {
    const fetch = deps.fetch ?? ((url: string) => net.fetch(url))
    const images = await resolveImages(note.id, note.path, [coverUrl], fetch)
    plan = fullPlan(book, { ...options, images })
  }

  const propertyPatch: Record<string, unknown> = {}
  for (const field of FRONTMATTER_FIELDS) {
    if (plan.frontmatter[field] !== undefined) propertyPatch[field] = plan.frontmatter[field]
  }
  const have = new Set(note.headerTags.map(foldTag))
  const wanted = Array.isArray(plan.frontmatter.tags) ? (plan.frontmatter.tags as string[]) : []
  const add = wanted.filter((tag) => !have.has(foldTag(tag)))
  const cover = plan.frontmatter.cover

  await updateNoteCommand({
    id: note.id,
    propertyPatch,
    ...(add.length > 0 ? { headerTags: { add } } : {}),
    ...(typeof cover === 'string' ? { frontmatter: { cover } } : {})
  })
}

function isLive(highlight: { is_deleted?: boolean | null; is_discard?: boolean | null }): boolean {
  return !highlight.is_deleted && !highlight.is_discard
}

/**
 * The Deleted books list (D16): link rows in state `note-deleted`, oldest
 * deletion last. The link row holds no title, so a v2 book is named by one
 * `ids=` read and a Reader document that has no book by one v3 read each. An
 * item gone from Readwise cannot be restored and is left out.
 */
export async function listDeletedBooks(): Promise<ReadwiseDeletedBook[]> {
  const token = await requireToken()
  const rows = listLinks(getDatabase(), 'note-deleted')
  const bookRows = rows.filter((row) => row.readwiseBookId !== null)
  const documentRows = rows.filter((row) => row.readwiseBookId === null && row.readerDocumentId)
  const deleted: ReadwiseDeletedBook[] = []

  const books =
    bookRows.length === 0
      ? new Map<number, ReadwiseBook>()
      : await fetchBooks(
          token,
          bookRows.map((row) => row.readwiseBookId as number)
        )
  for (const row of bookRows) {
    const book = books.get(row.readwiseBookId as number)
    if (!book || book.is_deleted) continue
    deleted.push({
      readwiseBookId: book.user_book_id,
      readerDocumentId: row.readerDocumentId,
      title: (book.readable_title || book.title || '').trim() || 'Untitled',
      deletedAt: row.updatedAt,
      highlightCount: (book.highlights ?? []).filter(isLive).length
    })
  }
  for (const row of documentRows) {
    const document = await getDocument({
      token,
      id: row.readerDocumentId as string,
      withHtmlContent: false
    })
    if (!document) continue
    deleted.push({
      readwiseBookId: null,
      readerDocumentId: document.id,
      title: (document.title ?? '').trim() || 'Untitled',
      deletedAt: row.updatedAt,
      highlightCount: 0
    })
  }
  return deleted.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt))
}

/** Restore (D16): the note is created the way a new book gets one, and the link is `linked` again. */
export async function restoreBook(
  readwiseBookId: number,
  deps: BookCommandDeps = {}
): Promise<void> {
  const token = await requireToken()
  const link = getLinkByBookId(getDatabase(), readwiseBookId)
  if (link?.state !== 'note-deleted') throw new Error(t('errors:importer.readwiseNotDeleted'))
  const options = planOptions()
  const book = await fetchLiveBook(token, readwiseBookId)
  const outcome = await upsertReadwiseNote(book, fullPlan(book, options), {
    restore: true,
    planOptions: options,
    fetch: deps.fetch
  })
  failureOf(outcome)
}

/**
 * Restore for a Reader document that has no v2 book (D16): the note comes back
 * the way a new document gets one, with its section, and with the article text
 * and images when **Include full article text** is on. The text is written once,
 * here, as at creation (D11).
 */
export async function restoreReaderDocument(
  readerDocumentId: string,
  deps: BookCommandDeps = {}
): Promise<void> {
  const token = await requireToken()
  const link = getLinkByReaderDocumentId(getDatabase(), readerDocumentId)
  if (link?.state !== 'note-deleted') throw new Error(t('errors:importer.readwiseNotDeleted'))
  const options = readReadwiseOptions(getDatabase())
  const document = await getDocument({
    token,
    id: readerDocumentId,
    withHtmlContent: options.readerFullText
  })
  if (!document) throw new Error(t('errors:importer.readwiseBookGone'))
  const outcome = await writeReaderNote(document, {
    root: options.rootFolder,
    folderLayout: options.folderLayout,
    fullText: options.readerFullText,
    restore: true,
    fetch: deps.fetch
  })
  if (outcome.status === 'failed') throw new Error(outcome.reason)
  if (outcome.status === 'skipped') throw new Error(t('errors:importer.readwiseBookBusy'))
}
