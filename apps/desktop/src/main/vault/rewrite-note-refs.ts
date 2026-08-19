/**
 * Re-point a note's relative refs when the note itself moves.
 *
 * Attachments are written into a note as a path relative to *the note*
 * (`../attachments/<noteId>/x.pdf` — see `noteRelativeRef` in `main/lib/paths.ts`
 * and `saveAttachment`), while the bytes live at `attachments/<noteId>/` and stay
 * there forever. So the ref is only correct for the folder the note was in when it
 * was written: move `notes/Foo.md` to `notes/archive/2026/Foo.md` and every
 * `../attachments/...` in its body is now one level short, the embed goes blank,
 * and the file is still sitting on disk. The same is true of any plain relative ref
 * at another vault file — a sidebar drop of `notes/images/photo.png`, or an
 * Obsidian-authored `../Images/photo.png` — which moves with neither side.
 *
 * The fix is arithmetic, not bookkeeping: resolve each ref against the *old* note
 * directory to get the vault-relative target it always meant, then express that
 * same target relative to the *new* directory.
 *
 * Two things this deliberately does not do:
 *
 *  - It never rewrites a ref it does not own. Anything with a URL scheme
 *    (`https:`, `data:`, `memry-file:`, a Windows `C:`), anything rooted at `/`
 *    or `\`, and anything that climbs above the vault root is left exactly as
 *    written. Wiki-links (`[[Title]]`) resolve by title, not by path, so a move
 *    cannot invalidate them and they are not touched either.
 *  - It never returns a body that differs only cosmetically. Refs are commonly
 *    percent-encoded, and decoding for the path math then re-encoding would churn
 *    every escape we do not reproduce byte-for-byte (`%C3%A9`), so a ref whose
 *    resolved path is unchanged keeps its original bytes. A move that leaves the
 *    note's folder alone returns null before reading a single line.
 */

import path from 'path'
import { FILE_BLOCK_LINE_REGEX, parseFileBlockMarker } from '@memry/editor-schema/blocks'
import { noteRelativeRef } from '../lib/paths'
// The same encoding the importers and `resolve-embed` apply: the ref goes back
// into markdown as `![alt](ref)`, where a raw space or paren truncates the link.
import { encodeAttachmentUrl } from '../import/_shared/attachment-markdown'

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows, which we also skip. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/** `![alt](ref)`. The ref stops at whitespace or a paren, both of which are encoded. */
const IMAGE_EMBED_REGEX = /(!\[[^\]]*\]\()([^()\s]*)(\))/g

/** The `"url":"…"` member of a file marker's JSON payload, escapes included. */
const MARKER_URL_REGEX = /"url":"(?:[^"\\]|\\.)*"/

/**
 * A comment terminator inside the payload closes the marker early and spills the
 * rest of it into the note as a paragraph. Restated from `serializeFileBlock`,
 * which does not export its escape: a filename like `a-->b.pdf` arrives here
 * already escaped, `JSON.parse` hands it back raw, and it has to go back escaped.
 */
function escapeCommentTerminator(json: string): string {
  return json.replace(/--(!?)>/g, '--$1\\u003e')
}

function dirOf(notePath: string): string {
  const dir = path.posix.dirname(notePath.replace(/\\/g, '/'))
  return dir === '.' ? '' : dir
}

/**
 * The vault-relative file a ref names when read from `noteDir`, or null when the
 * ref is not a vault-internal relative path.
 */
function resolveAgainstNoteDir(noteDir: string, ref: string): string | null {
  const joined = path.posix.normalize(path.posix.join(noteDir, ref.replace(/\\/g, '/')))
  // `..`, `../x` — above the vault root. `/x` — a ref that normalized to absolute.
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) return null
  if (joined === '.' || joined === '') return null
  return joined
}

/**
 * One ref, re-pointed. Returns null when the ref is not ours to rewrite or when
 * the path math leaves it exactly as written — in both cases the caller keeps the
 * original bytes rather than a re-encoded equivalent.
 */
function rewriteRef(ref: string, oldNoteDir: string, newNotePath: string): string | null {
  if (!ref) return null
  if (HAS_SCHEME.test(ref)) return null
  // A leading separator is ambiguous (vault root? filesystem root? a Windows UNC
  // share, for `\\server\share`?) — don't guess, the way the renderer's resolver
  // doesn't either.
  if (ref.startsWith('/') || ref.startsWith('\\')) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(ref)
  } catch {
    decoded = ref
  }

  const target = resolveAgainstNoteDir(oldNoteDir, decoded)
  if (!target) return null

  const next = noteRelativeRef(newNotePath, target)
  if (!next || next === decoded) return null

  return encodeAttachmentUrl(next)
}

/**
 * The body with every vault-internal relative ref re-pointed at the file it
 * already named, or null when nothing changed.
 *
 * Null is the signal not to write: the move path byte-compares nothing, it simply
 * skips the write, so a note that carries no refs — or carries only absolute ones
 * — keeps its `mtime` and its sync state untouched.
 *
 * @param body        The note file's contents, frontmatter included.
 * @param oldNotePath Vault-relative path the note had before the move.
 * @param newNotePath Vault-relative path the note has after the move.
 */
export function rewriteNoteRefsForMove(
  body: string,
  oldNotePath: string,
  newNotePath: string
): string | null {
  const oldNoteDir = dirOf(oldNotePath)
  // Same folder means every ref still resolves; a rename inside one folder, which
  // is by far the common case, costs one string compare.
  if (oldNoteDir === dirOf(newNotePath)) return null
  if (!body) return null

  let changed = false

  const rewritten = body
    .split('\n')
    .map((line) => {
      if (FILE_BLOCK_LINE_REGEX.test(line.trim())) {
        const props = parseFileBlockMarker(line.trim())
        if (!props) return line
        const next = rewriteRef(props.url, oldNoteDir, newNotePath)
        if (next === null) return line
        changed = true
        // Surgical: only the `url` member is replaced, so width/height/align and
        // any member a newer version writes survive byte-for-byte. A function
        // replacement keeps `$` in a filename from being read as a backreference.
        return line.replace(MARKER_URL_REGEX, () =>
          escapeCommentTerminator(`"url":${JSON.stringify(next)}`)
        )
      }

      return line.replace(IMAGE_EMBED_REGEX, (match, open: string, ref: string, close: string) => {
        const next = rewriteRef(ref, oldNoteDir, newNotePath)
        if (next === null) return match
        changed = true
        return `${open}${next}${close}`
      })
    })
    .join('\n')

  return changed ? rewritten : null
}
