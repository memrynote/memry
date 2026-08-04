import { JSDOM } from 'jsdom'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown, encodeAttachmentUrl } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { forEachZipEntry } from '../_shared/zip'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { parsePageInfo } from './parse-info'
import { NotionResolverInfo } from './resolver'
import { convertHtmlToMarkdown } from './convert-to-md'
import { getNotionId, parseParentIds, stripNotionId } from './notion-utils'

const ROOT = 'Notion'
const logger = createLogger('NotionImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

function decodeName(name: string): string {
  try {
    return decodeURIComponent(name)
  } catch {
    return name
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const notionImporter: Importer = {
  id: 'notion',
  name: 'Notion',
  descriptionKey: 'import.sources.notion',
  fileSpec: { label: 'Notion HTML export', extensions: ['zip'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    const info = new NotionResolverInfo()
    const attachmentBytes = new Map<string, Buffer>()

    // ---- Pass 1: scan page tree + buffer attachments ----
    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.scanningExport)
    await forEachZipEntry(input.sourcePaths, ctx.signal, async (entry) => {
      if (ctx.isCancelled()) return
      if (entry.name === 'index.html') return
      if (entry.extension === 'csv') return
      if (entry.extension === 'md' && getNotionId(entry.name)) {
        throw new Error('This looks like a Notion Markdown export. Please re-export as HTML.')
      }

      if (entry.extension === 'html') {
        try {
          const doc = new JSDOM(await entry.readText()).window.document
          const page = parsePageInfo(doc, entry.filepath)
          info.idsToFileInfo[page.id] = { ...page, path: entry.filepath }
        } catch (error) {
          ctx.reportSkipped(entry.filepath, errorMessage(error))
        }
      } else {
        info.pathsToAttachmentInfo[entry.filepath] = {
          path: entry.filepath,
          parentIds: parseParentIds(entry.filepath),
          nameWithExtension: stripNotionId(decodeName(entry.name)),
          targetParentFolder: ''
        }
        attachmentBytes.set(entry.filepath, await entry.read())
      }

      ctx.reportProgress(
        Object.keys(info.idsToFileInfo).length + Object.keys(info.pathsToAttachmentInfo).length,
        0
      )
    })
    if (ctx.isCancelled()) return ctx.toSummary()

    info.cleanDuplicates(`${ROOT}/`)

    // ---- Pass 2: convert each page + write ----
    ctx.setPhase('importing')
    const total = Object.keys(info.idsToFileInfo).length
    let done = 0
    await forEachZipEntry(input.sourcePaths, ctx.signal, async (entry) => {
      if (ctx.isCancelled()) return
      if (entry.extension !== 'html') return
      const id = getNotionId(entry.name)
      if (!id) return
      const fileInfo = info.idsToFileInfo[id]
      if (!fileInfo) return

      try {
        ctx.status(importingItemStatus(fileInfo.title))
        const doc = new JSDOM(await entry.readText()).window.document
        const { body, properties, tags, assets } = convertHtmlToMarkdown(info, doc, entry.filepath)
        const folder = `${ROOT}/${info.getPathForFile(fileInfo)}`.replace(/\/+$/, '')

        // Pre-generate the note id so attachments can be saved under it before
        // the note exists. The note is then created once with the fully resolved
        // body — no create-then-update round trip (whose getNoteById can miss the
        // just-written cache mid-import, throw, and drop every rewrite).
        const noteId = generateNoteId()

        // Copy this page's attachments into the note and rewrite the refs.
        let rewritten = body
        for (const ref of new Set(assets)) {
          const bytes = attachmentBytes.get(ref)
          const attachmentInfo = info.pathsToAttachmentInfo[ref]
          if (!bytes || !attachmentInfo) continue
          const result = await saveAttachment(noteId, bytes, attachmentInfo.nameWithExtension)
          const md = attachmentMarkdown(result)
          if (md) {
            if (result.type === 'image') {
              // Images embed inline; url-encode so spaced/paren filenames don't
              // truncate the `![](...)` link.
              const encoded = encodeAttachmentUrl(result.path!)
              rewritten = rewritten.split(`](${ref})`).join(`](${encoded})`)
            } else {
              // Other files become a clickable file block, replacing the whole
              // `![alt](ref)` / `[text](ref)` token the converter emitted.
              rewritten = rewritten.replace(
                new RegExp('!?\\[[^\\]]*\\]\\(' + escapeRegExp(ref) + '\\)', 'g'),
                () => md
              )
            }
            ctx.reportAttachment()
          } else {
            ctx.reportSkipped(attachmentInfo.nameWithExtension, result.error)
          }
        }

        await createNote({
          id: noteId,
          title: fileInfo.title,
          content: rewritten,
          folder,
          tags,
          properties,
          created: fileInfo.ctime?.toISOString(),
          modified: fileInfo.mtime?.toISOString()
        })
        ctx.reportImported()

        done++
        ctx.reportProgress(done, total)
      } catch (error) {
        logger.warn('page import failed', { filepath: entry.filepath })
        ctx.reportFailed(entry.filepath, error)
      }
    })

    return ctx.toSummary()
  }
}
