import { net } from 'electron'
import {
  planReaderNote,
  readerDocumentUrl,
  type PlanReaderNoteOptions,
  type ReaderNotePlan
} from '@memry/importers/readwise'
import { getDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { createImportedNote } from '../import/_shared/imported-note'
import { updateNoteCommand } from '../notes/domain'
import { getStatus } from '../vault'
import { getNoteById } from '../vault/notes'
import type { RemoteFetch } from '../vault/remote-attachment'
import { resolveImages } from './images'
import { getLinkByReaderDocumentId, markLinkState, upsertLink } from './links-repository'
import { findNoteByReadwiseUrl, isBusy } from './note-writer'
import type { ReaderDocument } from './reader'
import { prepareReaderFullText } from './reader-full-text'

const log = createLogger('ReadwiseReaderNotes')

export type ReaderOutcome =
  | { status: 'created'; noteId: string }
  /** The document already has a note. It is never written again (D4, D11). */
  | { status: 'unchanged'; noteId: string }
  | { status: 'skipped'; reason: 'note-deleted' | 'source-deleted' | 'has-book' }
  | { status: 'failed'; reason: string }

export interface ReaderNoteOptions extends Pick<
  PlanReaderNoteOptions,
  'root' | 'folderLayout' | 'bookExternalIds'
> {
  /** Write the article text below the section. Only when the note is created. */
  fullText: boolean
  /**
   * Restore (D16): a note the user deleted comes back. The link's `note-deleted`
   * state is ignored, a note that already names the document is adopted, and
   * otherwise the note is created as for a new document.
   */
  restore?: boolean
  fetch?: RemoteFetch
}

/** The body of a new note: the section, then the article text when there is one. */
function bodyOf(plan: ReaderNotePlan): string {
  return plan.fullText ? `${plan.section}\n\n${plan.fullText}` : plan.section
}

/**
 * The one write path from a saved Reader document into the vault (D11). A
 * document gets a note once. Its link row (or a note that already names it
 * in `readwise_url`) means the note exists: whether it came from this pass,
 * from the v2 book of the same document, or from another device, it is left
 * as the user has it. Failures do not throw: the Reader cursor stays put and
 * the next pass reads the document again.
 */
export async function writeReaderNote(
  document: ReaderDocument,
  options: ReaderNoteOptions
): Promise<ReaderOutcome> {
  try {
    return await write(document, options)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.warn('A Reader document could not be written', { documentId: document.id, error })
    return { status: 'failed', reason }
  }
}

async function write(document: ReaderDocument, options: ReaderNoteOptions): Promise<ReaderOutcome> {
  const db = getDatabase()
  const link = getLinkByReaderDocumentId(db, document.id)
  if (link && !options.restore) {
    if (link.state !== 'linked') return { status: 'skipped', reason: link.state }
    if (await getNoteById(link.noteId)) return { status: 'unchanged', noteId: link.noteId }
    // A missing row also means "not indexed yet". `note-deleted` is sticky (D9).
    if (getStatus().isIndexing) throw new Error('The vault is still indexing')
    markLinkState(db, { readerDocumentId: document.id }, 'note-deleted')
    return { status: 'skipped', reason: 'note-deleted' }
  }

  const existing = await findNoteByReadwiseUrl(readerDocumentUrl(document))
  if (existing) {
    upsertLink(db, { readerDocumentId: document.id, noteId: existing.id })
    return { status: 'unchanged', noteId: existing.id }
  }

  const article =
    options.fullText && document.html_content
      ? await prepareReaderFullText(document.html_content, document.url)
      : null
  const planOptions = { ...options, fullText: article?.render(new Map()) ?? null }
  const plan = planReaderNote(document, planOptions)
  if (plan === null) return { status: 'skipped', reason: 'has-book' }

  const { tags, ...properties } = plan.frontmatter
  const created = await createImportedNote({
    title: plan.title,
    folder: plan.folder,
    properties,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Array.isArray narrows to any[]; element type is the one stored by writers of this field
    tags: Array.isArray(tags) ? (tags as string[]) : undefined,
    content: bodyOf(plan),
    plainChecklists: true
  })
  upsertLink(db, { readerDocumentId: document.id, noteId: created.id })

  // Images need the note to exist (D14): download them, then plan again with
  // the refs. The article's images come out of the text without them, so the
  // note is complete only once this second write lands (D6).
  const fetch = options.fetch ?? ((url: string) => net.fetch(url))
  const before = await getNoteById(created.id)
  const images = await resolveImages(
    created.id,
    created.path,
    [...plan.imageUrls, ...(article?.imageUrls ?? [])],
    fetch
  )
  if (images.size > 0) {
    const withImages = planReaderNote(document, {
      ...planOptions,
      images,
      fullText: article?.render(images) ?? null
    })
    // Edited meanwhile, open in an editor, or just synced in (D6): leave it, the images stay attachments.
    const latest = await getNoteById(created.id)
    if (
      !withImages ||
      before === null ||
      latest?.content !== before.content ||
      isBusy(created.id)
    ) {
      log.warn('A Reader note changed while its images downloaded; they stay attachments only', {
        documentId: document.id
      })
    } else {
      const cover = withImages.frontmatter.cover
      try {
        await updateNoteCommand({
          id: created.id,
          content: bodyOf(withImages),
          ignoreInlineTags: true,
          ...(cover === undefined ? {} : { frontmatter: { cover } })
        })
      } catch (error) {
        // The note exists and is linked, so the run must not fail: the text is written once.
        log.warn('A Reader note could not be written with its images', {
          documentId: document.id,
          error
        })
      }
    }
  }
  return { status: 'created', noteId: created.id }
}
