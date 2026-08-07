/**
 * Pure path algebra for canvas folders.
 *
 * A canvas folder is a path relative to `<vault>/canvases`, always
 * forward-slashed (`Work/Q3`), with `null` meaning the root. No I/O here on
 * purpose: the store, the sync handler and the renderer all need the same
 * rules, and rules that touch the filesystem cannot be tested cheaply.
 *
 * @module canvas/folder-paths
 */

/**
 * Deepest nesting a canvas folder may reach — enforced here, at construction,
 * and matched by the recursive walk in `scene-file.listCanvasFiles`. Both ends
 * must agree on the number: a folder created deeper than the walk goes would
 * hold canvases the app never lists, visible in Finder and nowhere else.
 */
export const MAX_CANVAS_FOLDER_DEPTH = 8

/**
 * Comparison key for "is this the same file/folder?" — never for opening one.
 *
 * Two normalizations, both platform reality rather than taste:
 * - **case**: macOS and Windows default to case-insensitive filesystems, so
 *   `Plan` and `plan` are one file there.
 * - **Unicode**: macOS stores filenames decomposed (NFD), so a canvas titled
 *   `Yağmur` written by the app (NFC) comes back from `readdir` as different
 *   bytes for the same name. Without this, every vault open would see a
 *   "new" file and rewrite the row's path.
 *
 * The stored path always keeps the bytes as they exist on disk, because Linux
 * filesystems are normalization-SENSITIVE: a path normalized to NFC would not
 * open a file that arrived NFD from a Mac.
 *
 * Lives in this module, not in `scene-file`, because it is pure path algebra
 * and the folder rules below need it — importing it the other way round made
 * the two modules a cycle. `scene-file` re-exports it for its own callers.
 */
export function canvasPathKey(relativePath: string): string {
  return relativePath.normalize('NFC').toLowerCase()
}

function assertFolderDepth(segments: string[]): void {
  if (segments.length > MAX_CANVAS_FOLDER_DEPTH) {
    // No folder name in the message: it is user content, and this error ends up
    // in the UI and in telemetry.
    throw new Error(`Canvas folders cannot nest deeper than ${MAX_CANVAS_FOLDER_DEPTH} levels`)
  }
}

/**
 * Canonical form of a folder path: `null` for the root, otherwise
 * slash-joined segments with no leading/trailing/repeated separators.
 *
 * Traversal segments are dropped, not resolved: a canvas folder is a label in a
 * tree, not a path to walk, and the canonical form every later caller trusts
 * must never carry a `..` for a downstream `path.join` to act on.
 *
 * Throws past `MAX_CANVAS_FOLDER_DEPTH` — refusing an over-deep folder here, at
 * the one funnel every folder goes through, beats letting it be created and
 * then silently vanish from `listCanvasFiles`.
 */
export function normalizeFolder(folder: string | null | undefined): string | null {
  if (!folder) return null
  const segments = folder
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
  assertFolderDepth(segments)
  return segments.length > 0 ? segments.join('/') : null
}

export function folderSegments(folder: string | null): string[] {
  return normalizeFolder(folder)?.split('/') ?? []
}

export function joinFolder(parent: string | null, name: string): string {
  const base = normalizeFolder(parent)
  const leaf = normalizeFolder(name)
  if (!leaf) throw new Error('Canvas folder name cannot be empty')
  const joined = base ? `${base}/${leaf}` : leaf
  // Each side cleared the cap on its own; only the sum can breach it.
  assertFolderDepth(joined.split('/'))
  return joined
}

export function parentFolder(folder: string | null): string | null {
  const segments = folderSegments(folder)
  if (segments.length <= 1) return null
  return segments.slice(0, -1).join('/')
}

/**
 * True when `candidate` IS `ancestor` or sits beneath it. Compared through
 * `canvasPathKey` (NFC + lowercase) because macOS and Windows are
 * case-insensitive and macOS stores filenames decomposed — `work/q3` and
 * `Work/Q3` are one folder there, and a cycle guard that missed that would
 * let a drag detach a whole subtree.
 *
 * Segment-wise rather than string `startsWith`, so `Workshop` is not treated
 * as a child of `Work`.
 */
export function isDescendantFolder(candidate: string | null, ancestor: string | null): boolean {
  const ancestorSegments = folderSegments(ancestor)
  if (ancestorSegments.length === 0) return true // everything lives under root
  const candidateSegments = folderSegments(candidate)
  if (candidateSegments.length < ancestorSegments.length) return false
  return ancestorSegments.every(
    (segment, index) => canvasPathKey(candidateSegments[index]) === canvasPathKey(segment)
  )
}

/**
 * Re-roots `folder` from under `from` to under `to`, leaving anything that is
 * not `from` or one of its descendants untouched (but still normalized).
 *
 * `from` must name a real folder. An empty one is the root, and every folder is
 * a descendant of the root — so a single call would re-root the entire vault
 * under `to`. That is never what a rename or a move means, so it throws rather
 * than quietly doing it (or quietly doing nothing, which reads as "the rename
 * did not work"). The function is pure, so the throw lands before any caller
 * has written a row; the same rule `joinFolder` already applies to a name.
 */
export function rewriteFolderPrefix(
  folder: string | null,
  from: string,
  to: string
): string | null {
  const fromSegments = folderSegments(from)
  if (fromSegments.length === 0) {
    throw new Error('Canvas folder rewrite needs a source folder')
  }
  if (!isDescendantFolder(folder, from)) return normalizeFolder(folder)
  const rest = folderSegments(folder).slice(fromSegments.length)
  const segments = [...folderSegments(to), ...rest]
  assertFolderDepth(segments)
  return segments.length > 0 ? segments.join('/') : null
}
