import { net } from 'electron'
import {
  planReaderNote,
  readerDocumentUrl,
  type PlanReaderNoteOptions
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
import { findNoteByReadwiseUrl, replaceSection } from './note-writer'
import type { ReaderDocument } from './reader'
import { readerFullText } from './reader-full-text'

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
  fetch?: RemoteFetch
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
  if (link) {
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

  const fullText =
    options.fullText && document.html_content ? await readerFullText(document.html_content) : null
  const planOptions = { ...options, fullText }
  const plan = planReaderNote(document, planOptions)
  if (plan === null) return { status: 'skipped', reason: 'has-book' }

  const { tags, ...properties } = plan.frontmatter
  const created = await createImportedNote({
    title: plan.title,
    folder: plan.folder,
    properties,
    tags: Array.isArray(tags) ? (tags as string[]) : undefined,
    content: plan.fullText ? `${plan.section}\n\n${plan.fullText}` : plan.section,
    plainChecklists: true
  })
  upsertLink(db, { readerDocumentId: document.id, noteId: created.id })

  // The image needs the note to exist (D14): download it, plan again with it.
  // Only the section is replaced, so the article text below it stays as written.
  const fetch = options.fetch ?? ((url: string) => net.fetch(url))
  const before = await getNoteById(created.id)
  const images = await resolveImages(created.id, created.path, plan.imageUrls, fetch)
  if (images.size > 0) {
    const withImages = planReaderNote(document, { ...planOptions, images })
    // Edited meanwhile (or open in an editor): leave it, the image stays an attachment.
    const latest = await getNoteById(created.id)
    if (withImages && before !== null && latest?.content === before.content) {
      const cover = withImages.frontmatter.cover
      await updateNoteCommand({
        id: created.id,
        content: replaceSection(before.content, withImages.section),
        ignoreInlineTags: true,
        ...(cover === undefined ? {} : { frontmatter: { cover } })
      })
    }
  }
  return { status: 'created', noteId: created.id }
}
