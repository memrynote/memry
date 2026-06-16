/**
 * Evernote .enex importer for Memry.
 *
 * Reads one or more .enex files, converts ENML content to Markdown using the
 * shared html-to-markdown converter, saves attachments, and rewrites embedded
 * resource references.
 *
 * Resource embedding strategy
 * ---------------------------
 * Evernote references embedded resources via `<en-media hash="<md5hex>" …/>`.
 * Before calling the HTML→Markdown converter we:
 *   1. Decode each resource's base64 bytes and compute its MD5 hash (Node crypto).
 *   2. Replace every `<en-media hash="H" type="image/…"/>` with
 *      `<img src="memry-enex:H">` and non-image resources with a plain anchor.
 *   3. The image hook in htmlToMarkdown intercepts `memry-enex:H` src values,
 *      collects the hash token, and emits a placeholder `![](memry-enex:H)`.
 *   4. After createNote we save each resource via saveAttachment and do a
 *      string-replace on the collected refs in the body.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { JSDOM } from 'jsdom'
import { parseEnex, prepareEnml, resourceByHash } from '@memry/evernote-import'
import { createNote, updateNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { createLogger } from '../../lib/logger'
import { sanitizeFilename } from '../../lib/export-utils'
import { htmlToMarkdown } from '../_shared/html-to-markdown'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'

const ROOT = 'Evernote'
const logger = createLogger('EvernoteImport')

const ENEX_SCHEME = 'memry-enex:'

/** Compute an MD5 hex digest from a base64-encoded string (no whitespace). */
function md5Hex(base64: string): string {
  const bytes = Buffer.from(base64, 'base64')
  return crypto.createHash('md5').update(bytes).digest('hex')
}

/** Derive a fallback filename for a resource given its MIME type. */
function resourceFilename(mime: string, hash: string): string {
  const ext = mime.split('/')[1]?.split(';')[0]?.replace(/\+.*$/, '') ?? 'bin'
  return `${hash.slice(0, 8)}.${ext}`
}

/**
 * Replace `<en-media hash="H" type="T"/>` in raw ENML with either an `<img>`
 * (for image/* types) or a named anchor placeholder (for everything else).
 * This happens BEFORE DOM parsing so the shared converter sees standard HTML.
 */
function substituteEnMedia(html: string): string {
  return html.replace(/<en-media\b([^>]*?)\/?>/gi, (_match, attrs) => {
    const hashMatch = attrs.match(/hash="([^"]+)"/)
    const mimeMatch = attrs.match(/type="([^"]+)"/)
    const hash = hashMatch?.[1] ?? ''
    const mime = mimeMatch?.[1] ?? ''
    if (!hash) return ''
    if (mime.startsWith('image/')) {
      return `<img src="${ENEX_SCHEME}${hash}" alt="">`
    }
    // Non-image: a link placeholder the markdown pass keeps as-is
    return `<a href="${ENEX_SCHEME}${hash}">[attachment]</a>`
  })
}

export const evernoteImporter: Importer = {
  id: 'evernote',
  name: 'Evernote',
  descriptionKey: 'import.sources.evernote',
  fileSpec: { label: 'Evernote export', extensions: ['enex'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    ctx.setPhase('scanning')
    ctx.status('Scanning .enex files…')

    // Tally total notes across all files for progress reporting
    const filePlans: Array<{ filePath: string; notebook: string }> = []
    for (const filePath of input.sourcePaths) {
      if (ctx.isCancelled()) return ctx.toSummary()
      const notebook = sanitizeFilename(path.basename(filePath, '.enex'))
      filePlans.push({ filePath, notebook })
    }

    ctx.setPhase('importing')

    for (const { filePath, notebook } of filePlans) {
      if (ctx.isCancelled()) return ctx.toSummary()

      let xml: string
      try {
        xml = fs.readFileSync(filePath, 'utf8')
      } catch (error) {
        ctx.reportFailed(filePath, error)
        continue
      }

      let notes
      try {
        notes = parseEnex(xml)
      } catch (error) {
        logger.warn('parseEnex failed', { filePath })
        ctx.reportFailed(filePath, error)
        continue
      }

      const folder = notebook ? `${ROOT}/${notebook}` : ROOT
      const total = notes.length
      let done = 0

      for (const enexNote of notes) {
        if (ctx.isCancelled()) return ctx.toSummary()

        try {
          ctx.status(`Importing ${enexNote.title}`)

          // Build hash → resource map (injecting Node's MD5 implementation)
          const hashMap = resourceByHash(enexNote.resources, md5Hex)

          // Prepare ENML: strip wrapper, convert todos, substitute en-media
          const innerHtml = prepareEnml(enexNote.contentHtml)
          const mediaHtml = substituteEnMedia(innerHtml)

          // Parse the HTML fragment in jsdom
          const dom = new JSDOM(`<html><body>${mediaHtml}</body></html>`)
          const body = dom.window.document.body

          // Collect memry-enex: tokens via the image hook
          const enexRefs: string[] = []

          const { markdown } = htmlToMarkdown(body, {
            image(src, _alt, _collect) {
              if (src.startsWith(ENEX_SCHEME)) {
                const hash = src.slice(ENEX_SCHEME.length)
                enexRefs.push(hash)
                // Emit placeholder; will be rewritten after saveAttachment
                return `![](${src})`
              }
              return null
            },
            anchor(href, text, _collect) {
              if (href.startsWith(ENEX_SCHEME)) {
                const hash = href.slice(ENEX_SCHEME.length)
                enexRefs.push(hash)
                return `[${text || 'attachment'}](${href})`
              }
              return null
            }
          })

          const note = await createNote({
            title: enexNote.title,
            content: markdown,
            folder,
            tags: enexNote.tags.length > 0 ? enexNote.tags : undefined,
            created: enexNote.created,
            modified: enexNote.updated
          })
          ctx.reportImported()

          // Save attachments and rewrite refs in the body
          let rewritten = markdown
          for (const hash of new Set(enexRefs)) {
            const resource = hashMap.get(hash)
            if (!resource) continue

            const bytes = Buffer.from(resource.base64, 'base64')
            const filename = resource.fileName ?? resourceFilename(resource.mime, hash)
            const result = await saveAttachment(note.id, bytes, filename)

            if (result.success && result.path) {
              // Replace both image and anchor placeholders
              const placeholder = `${ENEX_SCHEME}${hash}`
              rewritten = rewritten.split(`](${placeholder})`).join(`](${result.path})`)
              ctx.reportAttachment()
            } else {
              ctx.reportSkipped(filename, result.error)
            }
          }

          // Strip any en-media placeholders that never resolved (missing resource
          // or a failed save) so the internal `memry-enex:` scheme never leaks.
          rewritten = rewritten.replace(/!?\[[^\]]*\]\(memry-enex:[^)]*\)/g, '')

          if (rewritten !== markdown) {
            await updateNote({ id: note.id, content: rewritten })
          }

          done++
          ctx.reportProgress(done, total)
        } catch (error) {
          logger.warn('note import failed', { title: enexNote.title, filePath })
          ctx.reportFailed(enexNote.title, error)
        }
      }
    }

    return ctx.toSummary()
  }
}
