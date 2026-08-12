import * as fs from 'fs/promises'
import * as path from 'path'
import { createNote } from '../../vault/notes-crud'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { parseFrontmatter, mapFiles } from '@memry/importers/markdown'
import type { FileDescriptor } from '@memry/importers/markdown'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { resolveCoLocatedAssets } from '../_shared/co-located-assets'

const logger = createLogger('MarkdownImport')

const MD_EXTENSIONS = new Set(['.md', '.markdown'])

/** Collect all .md/.markdown files under a directory recursively. */
async function collectMarkdownFiles(
  dir: string,
  rootDir: string,
  out: FileDescriptor[]
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectMarkdownFiles(absPath, rootDir, out)
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase()
      if (MD_EXTENSIONS.has(ext)) {
        out.push({ relPath: path.relative(rootDir, absPath), absPath, rootDir })
      }
    }
  }
}

export const markdownImporter: Importer = {
  id: 'markdown',
  name: 'Markdown',
  descriptionKey: 'import.sources.markdown',
  fileSpec: {
    label: 'Markdown files',
    extensions: ['md', 'markdown'],
    allowMultiple: true,
    // Folder picks are what make co-located media work: assets referenced as
    // `../Images/…` resolve against the selected folder, not the note's own.
    allowDirectory: true
  },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    // ---- Phase 1: scan ----
    ctx.setPhase('scanning')
    ctx.status(IMPORT_STATUS.scanningFiles)

    const descriptors: FileDescriptor[] = []

    for (const sourcePath of input.sourcePaths) {
      if (ctx.isCancelled()) return ctx.toSummary()

      let stat: Awaited<ReturnType<typeof fs.stat>>
      try {
        stat = await fs.stat(sourcePath)
      } catch (error) {
        ctx.reportFailed(sourcePath, error)
        continue
      }

      if (stat.isDirectory()) {
        await collectMarkdownFiles(sourcePath, sourcePath, descriptors)
      } else {
        const ext = path.extname(sourcePath).toLowerCase()
        if (MD_EXTENSIONS.has(ext)) {
          // A lone file grants nothing beyond its own folder, so that folder is
          // the root — assets must sit next to it or below it.
          descriptors.push({
            relPath: path.basename(sourcePath),
            absPath: sourcePath,
            rootDir: path.dirname(sourcePath)
          })
        }
      }
    }

    const plan = mapFiles(descriptors)
    const total = plan.notes.length
    ctx.reportProgress(0, total)

    if (ctx.isCancelled()) return ctx.toSummary()

    // ---- Phase 2: import each note ----
    ctx.setPhase('importing')
    let done = 0
    /** One `realpath` per selected root, reused by every note under it. */
    const realRoots = new Map<string, string>()

    for (const notePlan of plan.notes) {
      if (ctx.isCancelled()) return ctx.toSummary()

      try {
        ctx.status(importingItemStatus(notePlan.title))

        const raw = await fs.readFile(notePlan.absPath, 'utf8')
        const fileStat = await fs.stat(notePlan.absPath)
        const { title, tags, properties, body } = parseFrontmatter(raw)

        const noteTitle = title || notePlan.title

        // Pre-generate the note id so attachments can be saved under it before
        // the note exists. The note is then created once with the fully resolved
        // body — no create-then-update round trip (whose getNoteById can miss the
        // just-written cache mid-import, throw, and drop every rewrite).
        const noteId = generateNoteId()

        // ---- Attachments: save co-located assets referenced in the body ----
        const rewritten = await resolveCoLocatedAssets({
          body,
          noteId,
          noteAbsPath: notePlan.absPath,
          rootDir: notePlan.rootDir,
          ctx,
          realRoots
        })

        await createNote({
          id: noteId,
          title: noteTitle,
          content: rewritten,
          folder: notePlan.vaultFolder,
          tags,
          properties,
          created: fileStat.birthtime.toISOString(),
          modified: fileStat.mtime.toISOString()
        })
        ctx.reportImported()

        done++
        ctx.reportProgress(done, total)
      } catch (error) {
        logger.warn('note import failed', { absPath: notePlan.absPath })
        ctx.reportFailed(notePlan.absPath, error)
      }
    }

    return ctx.toSummary()
  }
}
