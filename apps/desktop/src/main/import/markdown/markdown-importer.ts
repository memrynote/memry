import * as fs from 'fs/promises'
import * as path from 'path'
import { createNote, updateNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { parseFrontmatter, extractAssetRefs, mapFiles } from '@memry/markdown-import'
import type { FileDescriptor } from '@memry/markdown-import'
import { percentDecodeRef } from '../_shared/html-to-markdown'

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
        out.push({ relPath: path.relative(rootDir, absPath), absPath })
      }
    }
  }
}

export const markdownImporter: Importer = {
  id: 'markdown',
  name: 'Markdown',
  descriptionKey: 'import.sources.markdown',
  fileSpec: { label: 'Markdown files', extensions: ['md', 'markdown'], allowMultiple: true },

  async run(input: ImportInput, ctx: ImportContext): Promise<ImportSummary> {
    // ---- Phase 1: scan ----
    ctx.setPhase('scanning')
    ctx.status('Scanning files…')

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
          descriptors.push({ relPath: path.basename(sourcePath), absPath: sourcePath })
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

    for (const notePlan of plan.notes) {
      if (ctx.isCancelled()) return ctx.toSummary()

      try {
        ctx.status(`Importing ${notePlan.title}`)

        const raw = await fs.readFile(notePlan.absPath, 'utf8')
        const fileStat = await fs.stat(notePlan.absPath)
        const { title, tags, properties, body } = parseFrontmatter(raw)

        const noteTitle = title || notePlan.title

        const note = await createNote({
          title: noteTitle,
          content: body,
          folder: notePlan.vaultFolder,
          tags,
          properties,
          created: fileStat.birthtime.toISOString(),
          modified: fileStat.mtime.toISOString()
        })
        ctx.reportImported()

        // ---- Attachments: save co-located assets referenced in the body ----
        const refs = extractAssetRefs(body)
        const sourceDir = path.dirname(notePlan.absPath)

        let rewritten = body
        for (const ref of refs) {
          if (ctx.isCancelled()) break

          // Refs in markdown are commonly URL-encoded (e.g. `My%20File.png`);
          // decode for disk resolution while keeping the original `ref` to rewrite
          // the body link. `../` is preserved so the traversal guard stays meaningful.
          const decodedRef = percentDecodeRef(ref)
          // Guard against path traversal — must stay within the same source directory tree
          const absRef = path.resolve(sourceDir, decodedRef)
          const refRelToSource = path.relative(sourceDir, absRef)
          if (refRelToSource.startsWith('..')) {
            ctx.reportSkipped(ref, 'Path traversal outside source directory')
            continue
          }

          let bytes: Buffer
          try {
            bytes = await fs.readFile(absRef)
          } catch {
            ctx.reportSkipped(ref, 'Asset file not found')
            continue
          }

          const result = await saveAttachment(note.id, bytes, path.basename(decodedRef))
          if (result.success && result.path) {
            rewritten = rewritten.split(`](${ref})`).join(`](${result.path})`)
            ctx.reportAttachment()
          } else {
            ctx.reportSkipped(ref, result.error)
          }
        }

        if (rewritten !== body) {
          await updateNote({ id: note.id, content: rewritten })
        }

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
