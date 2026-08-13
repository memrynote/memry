/**
 * Co-located asset resolution shared by the folder-shaped importers.
 *
 * An export keeps its media next to (or above) the notes that reference it.
 * This resolves each reference against the note's own folder, refuses anything
 * that escapes the folder the user actually selected, saves what is left as a
 * vault attachment, and rewrites the reference to point at it.
 *
 * @module import/_shared/co-located-assets
 */

import * as fs from 'fs/promises'
import * as path from 'path'
import { saveAttachment } from '../../vault/attachments'
import { extractAssetRefs } from '@memry/importers/markdown'
import { attachmentMarkdown } from './attachment-markdown'
import { percentDecodeRef } from './html-to-markdown'
import type { ImportContext } from '../types'

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

export interface CoLocatedAssetArgs {
  body: string
  /** Pre-generated note id — attachments are saved under it before the note exists. */
  noteId: string
  noteAbsPath: string
  /** The folder the user selected; assets may not resolve outside it. */
  rootDir: string
  ctx: ImportContext
  /** Caller-owned `realpath` cache, one entry per selection root. */
  realRoots: Map<string, string>
}

export async function resolveCoLocatedAssets(args: CoLocatedAssetArgs): Promise<string> {
  const { body, noteId, noteAbsPath, rootDir, ctx, realRoots } = args

  const refs = extractAssetRefs(body)
  const sourceDir = path.dirname(noteAbsPath)
  const realRoot = await resolveRealRoot(rootDir, realRoots)

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

  return rewritten
}
