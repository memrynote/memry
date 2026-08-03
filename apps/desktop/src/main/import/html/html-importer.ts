import { JSDOM } from 'jsdom'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown, encodeAttachmentUrl } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { htmlToMarkdown, percentDecodeRef } from '../_shared/html-to-markdown'
import { classifyRef, exceedsMaxSize, interFileWikilink, mapFiles } from '@memry/importers/html'
import type { HtmlFileDescriptor } from '@memry/importers/html'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'

const logger = createLogger('HtmlImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

/**
 * Validate a remote asset URL before fetching it into the vault.
 *
 * Restricts downloads to https and rejects loopback / private / link-local
 * hosts, so a malicious imported document can't drive an SSRF or write bytes
 * read from an internal service into the user's attachments folder.
 *
 * Returns the parsed URL when safe, or null when the reference must be skipped.
 */
function safeRemoteAssetUrl(ref: string): URL | null {
  let url: URL
  try {
    url = new URL(ref)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '0.0.0.0' ||
    host === '::1' ||
    host === '::' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^fe80:/i.test(host) ||
    /^f[cd][0-9a-f]{2}:/i.test(host)
  ) {
    return null
  }
  return url
}

/** Extract <title> text from a parsed document, falling back to the sanitized filename. */
function extractTitle(doc: Document, absPath: string): string {
  const titleEl = doc.querySelector('title')
  const titleText = titleEl?.textContent?.trim()
  if (titleText) return titleText
  return path.basename(absPath, path.extname(absPath))
}

/** Build a basename→title map (keys are lower-cased for case-insensitive lookup). */
function buildTitleMap(descriptors: HtmlFileDescriptor[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const { absPath, title } of descriptors) {
    const stem = path.basename(absPath, path.extname(absPath)).toLowerCase()
    map.set(stem, title)
  }
  return map
}

export const htmlImporter: Importer = {
  id: 'html',
  name: 'HTML',
  descriptionKey: 'import.sources.html',
  fileSpec: { label: 'HTML files', extensions: ['html', 'htm'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    // ---- Phase 1: scan — parse titles to build inter-file link map ----
    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.htmlScanning)

    const descriptors: HtmlFileDescriptor[] = []

    for (const sourcePath of input.sourcePaths) {
      if (ctx.isCancelled()) return ctx.toSummary()

      const ext = path.extname(sourcePath).toLowerCase()
      if (ext !== '.html' && ext !== '.htm') continue

      try {
        const html = await fs.readFile(sourcePath, 'utf8')
        const doc = new JSDOM(html).window.document
        const title = extractTitle(doc, sourcePath)
        descriptors.push({ relPath: path.basename(sourcePath), absPath: sourcePath, title })
      } catch (error) {
        logger.warn('scan failed', { sourcePath })
        ctx.reportFailed(sourcePath, error)
      }
    }

    const plan = mapFiles(descriptors)
    const total = plan.notes.length
    ctx.reportProgress(0, total)

    if (ctx.isCancelled()) return ctx.toSummary()

    // Build basename→title map for wikilink resolution
    const titleMap = buildTitleMap(descriptors)

    // ---- Phase 2: import each note ----
    ctx.setPhase('importing')
    let done = 0

    for (const notePlan of plan.notes) {
      if (ctx.isCancelled()) return ctx.toSummary()

      try {
        ctx.status(importingItemStatus(notePlan.title))

        const html = await fs.readFile(notePlan.absPath, 'utf8')
        const doc = new JSDOM(html).window.document

        const { markdown, assets } = htmlToMarkdown(doc.body, {
          anchor(href, _text, collect) {
            const wikiTitle = interFileWikilink(href, titleMap)
            if (wikiTitle != null) return `[[${wikiTitle}]]`
            // null → fall back to default (keeps external links as-is)
            void collect // collect unused in this branch
            return null
          },
          image(src, alt, collect) {
            const kind = classifyRef(src)
            if (kind === 'data') {
              // Keep data URIs inline — never download
              return `![${alt}](${src})`
            }
            // For http/file/local: collect the decoded ref for post-processing.
            // Percent-decode but PRESERVE `../` so parent-relative paths resolve
            // correctly and the traversal guard below can reject true escapes.
            const decoded = kind === 'http' ? src : percentDecodeRef(src)
            collect(decoded)
            return `![${alt}](${decoded})`
          }
        })

        // Pre-generate the note id so attachments can be saved under it before
        // the note exists. The note is then created once with the fully resolved
        // body — no create-then-update round trip (whose getNoteById can miss the
        // just-written cache mid-import, throw, and drop every rewrite).
        const noteId = generateNoteId()

        // ---- Post-process: download / read each collected asset ref ----
        let rewritten = markdown
        const htmlDir = path.dirname(notePlan.absPath)

        for (const ref of new Set(assets)) {
          if (ctx.isCancelled()) break

          const kind = classifyRef(ref)
          let bytes: Buffer

          try {
            if (kind === 'local') {
              const absRef = path.resolve(htmlDir, ref)
              // Path-traversal guard: must stay within htmlDir tree
              const rel = path.relative(htmlDir, absRef)
              if (rel.startsWith('..')) {
                ctx.reportSkipped(ref, 'unsafe path')
                continue
              }
              try {
                bytes = Buffer.from(await fs.readFile(absRef))
              } catch {
                ctx.reportSkipped(ref, 'not found')
                continue
              }
            } else if (kind === 'file') {
              // file:// URL → strip scheme, resolve to local path
              const localPath = decodeURIComponent(ref.replace(/^file:\/\//i, ''))
              const absRef = path.resolve(htmlDir, localPath)
              const rel = path.relative(htmlDir, absRef)
              if (rel.startsWith('..')) {
                ctx.reportSkipped(ref, 'unsafe path')
                continue
              }
              try {
                bytes = Buffer.from(await fs.readFile(absRef))
              } catch {
                ctx.reportSkipped(ref, 'not found')
                continue
              }
            } else if (kind === 'http') {
              const safeUrl = safeRemoteAssetUrl(ref)
              if (!safeUrl) {
                ctx.reportSkipped(ref, 'unsafe URL')
                continue
              }
              let resp: Response
              try {
                resp = await fetch(safeUrl.href)
              } catch (err) {
                ctx.reportSkipped(ref, errorMessage(err))
                continue
              }
              if (!resp.ok) {
                ctx.reportSkipped(ref, `HTTP ${resp.status}`)
                continue
              }
              bytes = Buffer.from(await resp.arrayBuffer())
            } else {
              // data: should never appear here (filtered in image hook), skip defensively
              continue
            }
          } catch (err) {
            logger.warn('asset fetch failed', { ref })
            ctx.reportFailed(ref, err)
            continue
          }

          if (exceedsMaxSize(bytes.length)) {
            ctx.reportSkipped(ref, 'too large')
            continue
          }

          const filename = path.basename(ref.split('?')[0])
          const result = await saveAttachment(noteId, bytes, filename)
          if (!result.success || !result.path) {
            ctx.reportSkipped(ref, result.error)
            continue
          }
          if (result.type === 'image') {
            // Image embed: keep the converter's `![alt](ref)` token and only swap
            // the path inside the parens (url-encoded so spaces/parens don't break
            // markdown), preserving any alt text from the source <img>.
            rewritten = rewritten.split(`](${ref})`).join(`](${encodeAttachmentUrl(result.path)})`)
          } else {
            // Non-image file: replace the whole `![alt](ref)` image token with a
            // clickable file block (alt is unknown here, so match it with a regex).
            const md = attachmentMarkdown(result)
            if (md) {
              const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              rewritten = rewritten.replace(new RegExp(`!\\[[^\\]]*\\]\\(${escaped}\\)`, 'g'), md)
            }
          }
          ctx.reportAttachment()
        }

        await createNote({
          id: noteId,
          title: notePlan.title,
          content: rewritten,
          folder: notePlan.vaultFolder
        })
        ctx.reportImported()

        done++
        ctx.reportProgress(done, total)
      } catch (error) {
        logger.warn('page import failed', { absPath: notePlan.absPath })
        ctx.reportFailed(notePlan.absPath, error)
      }
    }

    return ctx.toSummary()
  }
}
