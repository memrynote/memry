import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { parseKeepNote, mapKeepNote } from '@memry/importers/google-keep'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { forEachZipEntry } from '../_shared/zip'

const ROOT = 'Google Keep'
const logger = createLogger('GoogleKeepImport')

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Import error'
}

function basename(filePath: string): string {
  return path.posix.basename(filePath)
}

async function processNote(
  raw: unknown,
  assetMap: Map<string, Buffer>,
  ctx: ImportContext,
  sourceLabel: string
): Promise<void> {
  const keepNote = parseKeepNote(raw)
  if (!keepNote) {
    ctx.reportSkipped(sourceLabel, 'Not a Google Keep note')
    return
  }

  try {
    const mapped = mapKeepNote(keepNote)
    ctx.status(importingItemStatus(mapped.title))

    // Pre-generate the note id so attachments can be saved under it before the
    // note exists. The note is then created once with the fully resolved body —
    // no create-then-update round trip (whose getNoteById can miss the
    // just-written cache mid-import, throw, and drop every rewrite).
    const noteId = generateNoteId()

    // Save attachments and rewrite refs into the note body.
    let rewritten = mapped.body
    for (const attachPath of mapped.attachmentPaths) {
      if (ctx.isCancelled()) return
      const name = basename(attachPath)
      const bytes = assetMap.get(name)
      if (!bytes) {
        ctx.reportSkipped(name, 'Attachment file not found')
        continue
      }
      const result = await saveAttachment(noteId, bytes, name)
      // Images embed inline (url-encoded); other files become a clickable file
      // block. Appended after the body so the reference survives.
      const md = attachmentMarkdown(result)
      if (md) {
        rewritten = `${rewritten}\n\n${md}`
        ctx.reportAttachment()
      } else {
        ctx.reportSkipped(name, result.error)
      }
    }

    await createNote({
      id: noteId,
      title: mapped.title,
      content: rewritten,
      folder: ROOT,
      tags: mapped.tags,
      created: mapped.created,
      modified: mapped.modified
    })
    ctx.reportImported()
  } catch (error) {
    logger.warn('note import failed', { source: sourceLabel })
    ctx.reportFailed(sourceLabel, error)
  }
}

export const googleKeepImporter: Importer = {
  id: 'google-keep',
  name: 'Google Keep',
  descriptionKey: 'import.sources.google-keep',
  fileSpec: {
    label: 'Google Keep export',
    extensions: ['json', 'zip'],
    allowMultiple: true
  },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.scanningExport)

    // Collected entries: notes (parsed JSON) + asset bytes keyed by basename.
    const pendingNotes: Array<{ raw: unknown; label: string }> = []
    const assetMap = new Map<string, Buffer>()

    for (const sourcePath of input.sourcePaths) {
      if (ctx.isCancelled()) return ctx.toSummary()

      const ext = path.extname(sourcePath).toLowerCase().slice(1)

      if (ext === 'zip') {
        // Walk the zip: collect .json note entries + build asset map from everything else.
        // Skip .html and .txt duplicates that Keep exports alongside each note.
        await forEachZipEntry([sourcePath], ctx.signal, async (entry) => {
          if (ctx.isCancelled()) return
          if (entry.extension === 'html' || entry.extension === 'txt') return

          if (entry.extension === 'json') {
            const text = await entry.readText()
            let raw: unknown
            try {
              raw = JSON.parse(text)
            } catch {
              ctx.reportSkipped(entry.filepath, 'Invalid JSON')
              return
            }
            pendingNotes.push({ raw, label: entry.filepath })
          } else {
            // Treat as an asset — key by basename so note attachmentPaths can resolve it.
            // Isolate a corrupt member so it can't abort the whole scan.
            try {
              assetMap.set(entry.name, await entry.read())
            } catch (err) {
              ctx.reportSkipped(entry.filepath, errorMessage(err))
            }
          }
        })
      } else if (ext === 'json') {
        // Single JSON file on disk.
        let text: string
        try {
          text = await readFile(sourcePath, 'utf8')
        } catch (error) {
          ctx.reportFailed(sourcePath, errorMessage(error))
          continue
        }
        let raw: unknown
        try {
          raw = JSON.parse(text)
        } catch {
          ctx.reportFailed(sourcePath, 'Invalid JSON')
          continue
        }
        pendingNotes.push({ raw, label: sourcePath })

        // For a JSON file, try to load sibling attachment files referenced in the note.
        // Parse first to know which paths to look for.
        const note = parseKeepNote(raw)
        if (note) {
          const dir = path.dirname(sourcePath)
          for (const att of note.attachments) {
            if (ctx.isCancelled()) break
            const name = basename(att.filePath)
            if (assetMap.has(name)) continue
            const attPath = path.join(dir, att.filePath)
            try {
              assetMap.set(name, await readFile(attPath))
            } catch {
              // Missing sibling — will be reported as skipped during import.
            }
          }
        }
      }
    }

    if (ctx.isCancelled()) return ctx.toSummary()

    ctx.setPhase('importing')
    const total = pendingNotes.length
    let done = 0

    for (const { raw, label } of pendingNotes) {
      if (ctx.isCancelled()) return ctx.toSummary()
      await processNote(raw, assetMap, ctx, label)
      done++
      ctx.reportProgress(done, total)
    }

    ctx.setPhase('done')
    return ctx.toSummary()
  }
}
