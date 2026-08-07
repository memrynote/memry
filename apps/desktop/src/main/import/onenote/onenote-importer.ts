/**
 * OneNote importer: pulls notebooks → section groups → sections → pages from
 * the Microsoft Graph API (behind Microsoft OAuth), converts each page's HTML
 * to markdown via the shared jsdom converter, and writes one note per page
 * under `OneNote/<notebook>/<section group…>/<section>` (subpages nest under
 * their parent page).
 *
 * Fidelity handled here on top of the shared walker (see `page-dom.ts`):
 * OneNote tags → frontmatter tags, to-dos → task checkboxes, Consolas runs →
 * code blocks, styled spans → bold/italic/strike/highlight, MathML → LaTeX,
 * InkML handwriting → an SVG attachment, and attachments/images (remote Graph
 * resources and inline data URIs) → vault attachments.
 *
 * Options (`ImportInput.options`): `sectionIds` limits the import to selected
 * sections, `skipPreviouslyImported` (default on) skips pages recorded in the
 * vault's `.memry/import/onenote.json`, and `includeIncompatibleAttachments`
 * additionally saves file types Memry cannot embed natively (curated list —
 * never executables).
 *
 * The pure, fully-tested core (tree mapping, multipart split, HTML pre-pass,
 * InkML→SVG, MathML→LaTeX) lives in `@memry/importers/onenote`. OAuth + secure
 * token storage mirror Memry's Google Calendar flow (`onenote-auth.ts`).
 *
 * @module main/import/onenote/onenote-importer
 */

import { JSDOM } from 'jsdom'
import {
  extensionForMime,
  extractDataImages,
  inkmlToSvg,
  mapTree,
  parseOneNoteImportOptions,
  preparePageHtml,
  splitPageContent,
  type OneNoteImportOptions,
  type OneNotePage,
  type PagePlan
} from '@memry/importers/onenote'
import {
  IMPORT_STATUS,
  importingItemStatus,
  onenoteDownloadingAttachmentStatus
} from '@memry/importers/messages'
import { createNote } from '../../vault/notes-crud'
import {
  getFileExtension,
  isAllowedFileType,
  saveAttachment,
  type AttachmentResult
} from '../../vault/attachments'
import { attachmentMarkdown, encodeAttachmentUrl } from '../_shared/attachment-markdown'
import { htmlToMarkdown } from '../_shared/html-to-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import { getOneNoteAccessToken, resolveOneNoteClientId } from './onenote-auth'
import {
  createOneNoteGraphClient,
  flattenNotebookSections,
  type GraphFetch,
  type OneNoteGraphClient
} from './onenote-graph'
import {
  collectFileAttachments,
  collectRemoteImages,
  convertCodeRuns,
  convertInternalLinks,
  convertMathToLatex,
  convertOneNoteTags,
  convertStyledElements,
  convertVideoEmbeds,
  mergeCodeParagraphs,
  replaceWithParagraphText,
  sanitizeOcrText
} from './page-dom'
import {
  loadOneNoteImportState,
  saveOneNoteImportState,
  type OneNoteImportState
} from './onenote-state'
import type { ImportContext, Importer, ImportInput, ImportSummary } from '../types'

const logger = createLogger('OneNoteImport')

/** Abort the run after this many consecutive page failures. */
const MAX_CONSECUTIVE_FAILURES = 5

/**
 * Extensions the "include incompatible attachments" option additionally
 * accepts. These render as clickable file blocks (opened externally) rather
 * than inline embeds. Curated allowlist — executables/scripts stay out even
 * with the option on, which is where this deliberately diverges from the
 * Obsidian importer's anything-goes behaviour.
 */
const ONENOTE_EXTRA_EXTENSIONS = [
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'csv',
  'json',
  'xml',
  'log',
  'epub',
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'mp4',
  'mov',
  'm4v',
  'webm',
  'mkv',
  '3gp',
  'zip',
  // Image formats the editor cannot render inline (OneNote serves pasted
  // clipboard art as EMF/WMF/TIFF). They import as file blocks, not embeds.
  'bmp',
  'tif',
  'tiff',
  'emf',
  'wmf',
  'heic'
]

class ImportCancelled extends Error {
  constructor() {
    super('Import was cancelled')
    this.name = 'ImportCancelled'
  }
}

/**
 * Internal seam so tests can drive the importer without live auth or a real
 * client id. Production leaves these undefined and the real OAuth/Graph path is
 * used. Not part of the public Importer surface.
 */
export interface OneNoteRunDeps {
  clientId?: string
  getAccessToken?: (forceRefresh?: boolean) => Promise<string>
  fetch?: GraphFetch
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

interface PageAssets {
  attachments: number
  skipped: { item: string; reason: string }[]
}

/** Download + persist one attachment buffer, tolerating per-file failures. */
async function persistAttachment(
  graph: OneNoteGraphClient,
  noteId: string,
  url: string,
  filename: string,
  extraAllowed: boolean
): Promise<AttachmentResult | null> {
  let data: Buffer
  try {
    data = await graph.fetchBinary(url)
  } catch (error) {
    logger.warn('attachment download failed', { filename, error: errorMessage(error) })
    return null
  }
  return saveAttachment(
    noteId,
    data,
    filename,
    extraAllowed ? { extraAllowedExtensions: ONENOTE_EXTRA_EXTENSIONS } : undefined
  )
}

/** Convert one fetched page into a note (attachments included). */
async function importPage(
  plan: PagePlan,
  graph: OneNoteGraphClient,
  ctx: ImportContext,
  options: OneNoteImportOptions
): Promise<void> {
  const raw = await graph.getPageContent(plan.pageId)
  const parts = splitPageContent(raw)
  const prepared = preparePageHtml(parts.html)
  const { html: withPlaceholders, images: dataImages } = extractDataImages(prepared.html)

  const dom = new JSDOM(withPlaceholders)
  const body = dom.window.document.body

  const tags = convertOneNoteTags(body)
  convertInternalLinks(body)
  convertVideoEmbeds(body)
  convertMathToLatex(body)
  mergeCodeParagraphs(body)
  convertCodeRuns(body)
  convertStyledElements(body)

  // Pre-generate the note id so attachments can be saved under it before the
  // note exists. The note is then created once with the fully resolved body —
  // no create-then-update round trip (whose getNoteById can miss the
  // just-written cache mid-import, throw, and drop every rewrite).
  const noteId = generateNoteId()
  const assets: PageAssets = { attachments: 0, skipped: [] }

  // ---- File attachments (<object data-attachment>) ----
  for (const ref of collectFileAttachments(body)) {
    if (ctx.isCancelled()) throw new ImportCancelled()
    const ext = getFileExtension(ref.originalName)
    const native = isAllowedFileType(ref.originalName)
    const extraOk = options.includeIncompatibleAttachments && ONENOTE_EXTRA_EXTENSIONS.includes(ext)
    if (!native && !extraOk) {
      assets.skipped.push({
        item: ref.originalName,
        reason: options.includeIncompatibleAttachments
          ? `attachment type ".${ext}" is not supported`
          : `attachment type ".${ext}" needs "include incompatible attachments"`
      })
      ref.el.remove()
      continue
    }

    ctx.status(onenoteDownloadingAttachmentStatus(ref.originalName))
    const result = await persistAttachment(graph, noteId, ref.url, ref.originalName, extraOk)
    const md = result ? attachmentMarkdown(result) : null
    if (result && md) {
      // Images embed inline; other files become a clickable file block.
      replaceWithParagraphText(ref.el, md)
      assets.attachments++
    } else {
      assets.skipped.push({
        item: ref.originalName,
        reason: result?.error ?? 'download failed'
      })
      ref.el.remove()
    }
  }

  // ---- Remote images (authenticated Graph resources) ----
  let imageIndex = 0
  for (const ref of collectRemoteImages(body)) {
    if (ctx.isCancelled()) throw new ImportCancelled()
    imageIndex++
    const ext = ref.mime ? extensionForMime(ref.mime) : 'png'
    const filename = `${plan.title} image ${imageIndex}.${ext}`

    ctx.status(onenoteDownloadingAttachmentStatus(filename))
    const result = await persistAttachment(
      graph,
      noteId,
      ref.url,
      filename,
      options.includeIncompatibleAttachments
    )
    if (result?.success && result.path) {
      if (result.type === 'image') {
        ref.el.setAttribute('src', result.path)
        ref.el.setAttribute('alt', ref.alt || 'image')
      } else {
        // A format the editor cannot render (EMF/TIFF clipboard art): keep the
        // bytes as a file block rather than a permanently broken <img>.
        const md = attachmentMarkdown(result)
        if (md) replaceWithParagraphText(ref.el, md)
        else ref.el.remove()
      }
      assets.attachments++
    } else {
      assets.skipped.push({ item: filename, reason: result?.error ?? 'download failed' })
      ref.el.remove()
    }
  }

  // ---- Inline data-URI images (lifted by the pure pre-pass) ----
  for (const image of dataImages) {
    if (ctx.isCancelled()) throw new ImportCancelled()
    const filename = `${image.placeholder}.${extensionForMime(image.mime)}`
    const el = body.querySelector(`img[src="${image.placeholder}"]`)
    if (!el) {
      // An earlier transform (internal-link unwrap, code promotion) dropped the
      // placeholder — don't write bytes nothing will reference.
      assets.skipped.push({ item: filename, reason: 'image was removed during conversion' })
      continue
    }
    const result = await saveAttachment(noteId, Buffer.from(image.base64, 'base64'), filename)
    if (result.success && result.path) {
      el.setAttribute('src', result.path)
      // Raw OneNote OCR alt text can carry brackets/newlines that would break
      // the `![alt](url)` embed the walker emits.
      el.setAttribute('alt', sanitizeOcrText(el.getAttribute('alt') ?? '') || 'image')
      assets.attachments++
    } else {
      el.remove()
      assets.skipped.push({ item: filename, reason: result.error ?? 'could not save image' })
    }
  }

  // ---- Handwriting / drawings (InkML → SVG attachment) ----
  let inkMarkdown = ''
  if (parts.inkml) {
    const inkName = `${plan.title} - Ink.svg`
    try {
      const svg = inkmlToSvg(parts.inkml)
      if (svg) {
        const result = await saveAttachment(noteId, Buffer.from(svg, 'utf8'), inkName)
        const md = attachmentMarkdown(result)
        if (md) {
          // OneNote merges all ink on a page into one block; append it.
          inkMarkdown = `\n\n${md}`
          assets.attachments++
        } else {
          assets.skipped.push({ item: inkName, reason: result.error ?? 'could not save ink' })
        }
      }
    } catch (error) {
      const reason = errorMessage(error)
      logger.warn('ink conversion failed', { title: plan.title, error: reason })
      assets.skipped.push({ item: inkName, reason })
    }
  }

  const { markdown } = htmlToMarkdown(body, {
    // Saved attachment URLs pass through verbatim (percent-encoded); the
    // default image path would percent-decode and "collect" them as assets.
    image: (src, alt) =>
      src.startsWith('memry-file://') ? `![${alt}](${encodeAttachmentUrl(src)})` : undefined
  })

  let content = markdown
  if (inkMarkdown) content += inkMarkdown

  await createNote({
    id: noteId,
    title: plan.title,
    content,
    folder: plan.folder,
    ...(tags.length > 0 ? { tags } : {}),
    ...(plan.created ? { created: plan.created } : {}),
    ...(plan.modified ? { modified: plan.modified } : {})
  })

  // Report per-file outcomes only after the note landed, so a page that fails
  // later does not leave half its attachment counts behind.
  for (let i = 0; i < assets.attachments; i++) ctx.reportAttachment()
  for (const skip of assets.skipped) ctx.reportSkipped(skip.item, skip.reason)
}

async function runImport(
  input: ImportInput,
  ctx: ImportContext,
  deps: OneNoteRunDeps
): Promise<ImportSummary> {
  const clientId = deps.clientId ?? resolveOneNoteClientId()

  if (!clientId) {
    // Clear, non-crashing config-gap path: no Azure app registration yet.
    ctx.reportFailed(
      'OneNote',
      'OneNote import is not yet configured (Azure app registration required).'
    )
    return ctx.toSummary()
  }

  const options = parseOneNoteImportOptions(input.options)
  const getAccessToken =
    deps.getAccessToken ??
    ((forceRefresh?: boolean) => getOneNoteAccessToken({ clientId, forceRefresh }))

  const graph = createOneNoteGraphClient({
    getAccessToken,
    fetch: deps.fetch,
    isCancelled: () => ctx.isCancelled(),
    status: (m) => ctx.status(m),
    onRateLimited: () => ctx.status(IMPORT_STATUS.onenoteRateLimited)
  })

  // ---- Phase 1: scan the notebook → section group → section → page tree ----
  ctx.setPhase('scanning')
  ctx.status(IMPORT_STATUS.onenoteLoadingNotebooks)

  const trees = await graph.listNotebookTrees()
  if (ctx.isCancelled()) return ctx.toSummary()

  const notebooks = trees.map((tree) => ({ id: tree.id, displayName: tree.displayName }))
  let sections = trees.flatMap(flattenNotebookSections)
  if (options.sectionIds) {
    const wanted = new Set(options.sectionIds)
    sections = sections.filter((section) => wanted.has(section.id))
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

  const plans = mapTree(notebooks, sections, pages)
  const state: OneNoteImportState = await loadOneNoteImportState()

  // ---- Phase 2: import each page ----
  ctx.setPhase('importing')
  const total = plans.length
  let done = 0
  let consecutiveFailures = 0
  ctx.reportProgress(0, total)

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i]
    if (ctx.isCancelled()) return ctx.toSummary()

    if (options.skipPreviouslyImported && state.importedPageIds[plan.pageId]) {
      ctx.reportSkipped(plan.title, 'previously imported')
      done++
      ctx.reportProgress(done, total)
      continue
    }

    try {
      ctx.status(importingItemStatus(plan.title))
      await importPage(plan, graph, ctx, options)

      state.importedPageIds[plan.pageId] = new Date().toISOString()
      await saveOneNoteImportState(state)
      ctx.reportImported()
      consecutiveFailures = 0
    } catch (error) {
      if (ctx.isCancelled() || error instanceof ImportCancelled) {
        ctx.reportSkipped(plan.title, 'import was cancelled')
        return ctx.toSummary()
      }
      logger.warn('page import failed', { title: plan.title })
      ctx.reportFailed(plan.title, error)
      consecutiveFailures++
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // Something systemic is wrong (rate-limit storms are handled below the
        // Graph client; this is auth/content trouble). Stop burning the queue.
        for (let j = i + 1; j < plans.length; j++) {
          ctx.reportSkipped(plans[j].title, 'skipped after repeated failures')
        }
        ctx.reportProgress(total, total)
        return ctx.toSummary()
      }
    }

    done++
    ctx.reportProgress(done, total)
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
  accountBased: true,
  fileSpec: {
    label: 'Microsoft OneNote',
    extensions: [],
    allowMultiple: false
  },

  run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    return runImport(input, ctx, {})
  }
}
