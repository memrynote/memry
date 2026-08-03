import * as fs from 'fs/promises'
import * as path from 'path'
import { createNote } from '../../vault/notes-crud'
import { saveAttachment } from '../../vault/attachments'
import { attachmentMarkdown } from '../_shared/attachment-markdown'
import { generateNoteId } from '../../lib/id'
import { createLogger } from '../../lib/logger'
import type { Importer, ImportContext, ImportInput, ImportSummary } from '../types'
import { parseFrontmatter, extractAssetRefs, mapFiles } from '@memry/importers/markdown'
import type { FileDescriptor } from '@memry/importers/markdown'
import { IMPORT_STATUS, importingItemStatus } from '@memry/importers/messages'
import { percentDecodeRef } from '../_shared/html-to-markdown'

const logger = createLogger('MarkdownImport')

const MD_EXTENSIONS = new Set(['.md', '.markdown'])

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace every token pointing at `ref` with the already-built attachment
 * markdown, dropping whatever alt/link text the source authored. Mirrors
 * `extractAssetRefs`' token shapes — markdown `![alt](ref)` / `[text](ref)` and
 * Obsidian's `![[ref]]` embed — so images and non-image file blocks both swap
 * cleanly regardless of label.
 */
function replaceAssetToken(body: string, ref: string, replacement: string): string {
  const escaped = escapeRegExp(ref)
  const tokenRe = new RegExp(`!?\\[[^\\][]*\\]\\(${escaped}\\)`, 'g')
  // Obsidian carries the target inside the brackets, optionally followed by a
  // display size / alias (`|300x200`) or an anchor (`#page=3`); the whole embed
  // goes, tail included, since the attachment markdown cannot express either.
  const embedRe = new RegExp(`!\\[\\[${escaped}(?:[|#][^\\][]*)?\\]\\]`, 'g')
  // Function replacer so `$` in the attachment markdown (e.g. a filename) is not
  // treated as a `String.replace` substitution pattern.
  return body.replace(tokenRe, () => replacement).replace(embedRe, () => replacement)
}

/**
 * Real path of a selected root, memoised. Falls back to the literal path when
 * it cannot be resolved — the boundary check then behaves as it did before,
 * rather than dropping every asset under that root.
 */
async function resolveRealRoot(rootDir: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(rootDir)
  if (cached !== undefined) return cached
  let real = rootDir
  try {
    real = await fs.realpath(rootDir)
  } catch {
    // keep the literal path
  }
  cache.set(rootDir, real)
  return real
}

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
        const refs = extractAssetRefs(body)
        const sourceDir = path.dirname(notePlan.absPath)
        const realRoot = await resolveRealRoot(notePlan.rootDir, realRoots)

        let rewritten = body
        for (const ref of refs) {
          if (ctx.isCancelled()) break

          // Refs in markdown are commonly URL-encoded (e.g. `My%20File.png`);
          // decode for disk resolution while keeping the original `ref` to rewrite
          // the body link. `../` is preserved so the traversal guard stays meaningful.
          const decodedRef = percentDecodeRef(ref)
          // Refs are relative to the note, but the boundary is the folder the
          // user selected — exports routinely keep media in a sibling folder
          // (`../Images/Media/x.png`), which is still inside what they granted.
          const absRef = path.resolve(sourceDir, decodedRef)
          // A symlink inside the selection can point anywhere, and a string
          // compare would still read it as in-bounds while `readFile` walks
          // straight out of the folder — so resolve the ref for real first.
          // ENOENT here is a missing (or dangling) asset, same skip as a failed
          // read. `realRoot` is resolved the same way for a like-for-like
          // compare: macOS hands back `/private/var` for a `/var` path.
          let realRef: string
          try {
            realRef = await fs.realpath(absRef)
          } catch {
            ctx.reportSkipped(ref, 'Asset file not found')
            continue
          }
          const refRelToRoot = path.relative(realRoot, realRef)
          // Only a whole `..` segment escapes the root — a folder named `..img`
          // yields `..img/x.png`, which is inside it. `path.relative` also
          // returns an absolute path when the two sides live on different
          // Windows drives, so check that too.
          const escapesRoot = refRelToRoot === '..' || refRelToRoot.startsWith(`..${path.sep}`)
          if (escapesRoot || path.isAbsolute(refRelToRoot)) {
            ctx.reportSkipped(ref, 'Path traversal outside selected folder')
            continue
          }

          let bytes: Buffer
          try {
            bytes = await fs.readFile(realRef)
          } catch {
            ctx.reportSkipped(ref, 'Asset file not found')
            continue
          }

          const result = await saveAttachment(noteId, bytes, path.basename(decodedRef))
          // Images embed inline (url-encoded so spaces don't break `![](...)`);
          // other files become a clickable file block. Replaces the whole
          // `![alt](ref)` / `[text](ref)` token, not just the `](ref)` tail.
          const md = attachmentMarkdown(result)
          if (md) {
            rewritten = replaceAssetToken(rewritten, ref, md)
            ctx.reportAttachment()
          } else {
            ctx.reportSkipped(path.basename(decodedRef), result.error)
          }
        }

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
