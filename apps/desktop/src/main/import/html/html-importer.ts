import { JSDOM } from 'jsdom'
import * as fs from 'fs/promises'
import * as path from 'path'
import { createNote, updateNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { htmlToMarkdown, decodeRef } from '../_shared/html-to-markdown'
import { classifyRef, exceedsMaxSize, interFileWikilink, mapFiles } from '@memry/html-import'
import type { HtmlFileDescriptor } from '@memry/html-import'

const logger = createLogger('HtmlImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
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
    ctx.status('Scanning HTML files…')

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
        ctx.status(`Importing ${notePlan.title}`)

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
            // For http/file/local: collect the decoded ref for post-processing
            const decoded = kind === 'http' ? src : decodeRef(src)
            collect(decoded)
            return `![${alt}](${decoded})`
          }
        })

        const note = await createNote({
          title: notePlan.title,
          content: markdown,
          folder: notePlan.vaultFolder
        })
        ctx.reportImported()

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
              let resp: Response
              try {
                resp = await fetch(ref)
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
          const result = await saveAttachment(note.id, bytes, filename)
          if (result.success && result.path) {
            rewritten = rewritten.split(`](${ref})`).join(`](${result.path})`)
            ctx.reportAttachment()
          } else {
            ctx.reportSkipped(ref, result.error)
          }
        }

        if (rewritten !== markdown) {
          await updateNote({ id: note.id, content: rewritten })
        }

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
