// BLOCKED: requires an Azure app registration (ONENOTE_CLIENT_ID). Registered disabled until configured — see PR Blockers.
/**
 * OneNote importer: pulls notebooks → sections → pages from the Microsoft Graph
 * API (behind Microsoft OAuth), converts each page's HTML to markdown via the
 * shared jsdom converter, persists base64 images as vault attachments, and
 * writes one note per page under `OneNote/<notebook>/<section>`.
 *
 * The pure, fully-tested core (tree mapping, HTML normalization, image
 * extraction) lives in `@memry/onenote-import`. OAuth + secure token storage
 * mirror Memry's Google Calendar flow (`onenote-auth.ts`).
 *
 * EXTERNAL BLOCKER: OneNote needs an Azure app registration (a public-client
 * id + a loopback redirect URI). That cannot be provisioned here, so
 * {@link ONENOTE_CLIENT_ID} is left empty and {@link run} takes a clear,
 * non-crashing config-gap path until it is configured.
 *
 * @module main/import/onenote/onenote-importer
 */

import { JSDOM } from 'jsdom'
import {
  mapTree,
  preparePageHtml,
  extractDataImages,
  extensionForMime,
  type OneNotePage,
  type OneNoteSection,
  type PagePlan
} from '@memry/onenote-import'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown, encodeAttachmentUrl } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import { htmlToMarkdown } from '../_shared/html-to-markdown'
import { refreshAccessToken } from './onenote-auth'
import { createOneNoteGraphClient, type GraphFetch } from './onenote-graph'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'

const ROOT = 'OneNote'
const logger = createLogger('OneNoteImport')

// TODO(Azure app registration): set client id + redirect URI.
const ONENOTE_CLIENT_ID = ''

/** Escape a string for safe use inside a `new RegExp(...)` pattern. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Internal seam so tests can drive the importer without live auth or a real
 * client id. Production leaves these undefined and the real OAuth/Graph path is
 * used. Not part of the public Importer surface.
 */
export interface OneNoteRunDeps {
  clientId?: string
  getAccessToken?: () => Promise<string>
  fetch?: GraphFetch
}

/** Convert one prepared page's HTML into markdown + lifted images. */
function convertPage(html: string): {
  markdown: string
  images: { placeholder: string; base64: string; mime: string }[]
} {
  const { html: prepared } = preparePageHtml(html)
  const { html: withPlaceholders, images } = extractDataImages(prepared)
  const doc = new JSDOM(withPlaceholders).window.document
  const { markdown } = htmlToMarkdown(doc.body)
  return { markdown, images }
}

async function runImport(
  _input: ImportInput,
  ctx: ImportContext,
  deps: OneNoteRunDeps
): Promise<ImportSummary> {
  const clientId = deps.clientId ?? ONENOTE_CLIENT_ID

  if (!clientId) {
    // Clear, non-crashing config-gap path: no Azure app registration yet.
    ctx.reportFailed(
      'OneNote',
      'OneNote import is not yet configured (Azure app registration required).'
    )
    return ctx.toSummary()
  }

  const getAccessToken = deps.getAccessToken ?? (() => refreshAccessToken({ clientId }))

  const graph = createOneNoteGraphClient({
    getAccessToken,
    fetch: deps.fetch,
    isCancelled: () => ctx.isCancelled(),
    status: (m) => ctx.status(m)
  })

  // ---- Phase 1: scan the notebook → section → page tree ----
  ctx.setPhase('scanning')
  ctx.status('Loading OneNote notebooks…')

  const notebooks = await graph.listNotebooks()
  if (ctx.isCancelled()) return ctx.toSummary()

  const sections: OneNoteSection[] = []
  for (const notebook of notebooks) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      sections.push(...(await graph.listSections(notebook.id)))
    } catch (error) {
      ctx.reportFailed(notebook.displayName, error)
    }
  }

  const pages: OneNotePage[] = []
  for (const section of sections) {
    if (ctx.isCancelled()) return ctx.toSummary()
    try {
      pages.push(...(await graph.listPages(section.id)))
    } catch (error) {
      ctx.reportFailed(section.displayName, error)
    }
  }

  const plans: PagePlan[] = mapTree(notebooks, sections, pages)
  const total = plans.length
  ctx.reportProgress(0, total)

  // ---- Phase 2: import each page ----
  ctx.setPhase('importing')
  let done = 0

  for (const plan of plans) {
    if (ctx.isCancelled()) return ctx.toSummary()

    try {
      ctx.status(`Importing ${plan.title}`)

      const html = await graph.getPageHtml(plan.pageId)
      const { markdown, images } = convertPage(html)

      // Pre-generate the note id so attachments can be saved under it before the
      // note exists. The note is then created once with the fully resolved body —
      // no create-then-update round trip (whose getNoteById can miss the
      // just-written cache mid-import, throw, and drop every rewrite).
      const noteId = generateNoteId()

      // Persist lifted base64 images and rewrite their placeholder refs.
      let rewritten = markdown
      for (const image of images) {
        const bytes = Buffer.from(image.base64, 'base64')
        const filename = `${image.placeholder}.${extensionForMime(image.mime)}`
        const result = await saveAttachment(noteId, bytes, filename)
        const md = attachmentMarkdown(result)
        if (md) {
          // Images embed inline (url-encoded so spaced/paren filenames survive
          // markdown link parsing); other files become a clickable file block.
          if (result.type === 'image') {
            rewritten = rewritten
              .split(`](${image.placeholder})`)
              .join(`](${encodeAttachmentUrl(result.path!)})`)
          } else {
            rewritten = rewritten.replace(
              new RegExp('!\\[[^\\]]*\\]\\(' + escapeRegExp(image.placeholder) + '\\)', 'g'),
              () => md
            )
          }
          ctx.reportAttachment()
        } else {
          ctx.reportSkipped(filename, result.error)
        }
      }

      await createNote({
        id: noteId,
        title: plan.title,
        content: rewritten,
        folder: plan.folder.startsWith(`${ROOT}/`) ? plan.folder : `${ROOT}/${plan.folder}`,
        created: plan.created
      })
      ctx.reportImported()

      done++
      ctx.reportProgress(done, total)
    } catch (error) {
      logger.warn('page import failed', { title: plan.title })
      ctx.reportFailed(plan.title, error)
    }
  }

  return ctx.toSummary()
}

/**
 * Test-only entry point that lets a harness inject a client id + fetch without
 * live auth. Production code uses {@link onenoteImporter}.
 */
export function runOneNoteImportWithDeps(
  input: ImportInput,
  ctx: ImportContext,
  deps: OneNoteRunDeps
): Promise<ImportSummary> {
  return runImport(input, ctx, deps)
}

export const onenoteImporter: Importer = {
  id: 'onenote',
  name: 'OneNote',
  descriptionKey: 'import.sources.onenote',
  fileSpec: {
    label: 'Microsoft OneNote (via Microsoft account)',
    extensions: [],
    allowMultiple: false
  },

  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    return runImport(input, ctx, {})
  }
}
