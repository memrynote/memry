/**
 * Resolve a note-relative asset URL to a `memry-file://` URL the renderer can load.
 *
 * Vaults written by other apps (Obsidian, Capacities, …) reference media with a
 * plain relative path — `![x](../Images/Media/photo.png)`. BlockNote hands that
 * string straight to `<img src>`, where it resolves against the *renderer
 * document's* base URL (`http://localhost:5173/` in dev, `file://…/out/` when
 * packaged) rather than the vault, and 404s.
 *
 * This runs at render time only: the markdown on disk keeps its relative path,
 * so the vault stays readable by the app that wrote it.
 */

import { toMemryFileUrl } from './memry-file-url'

/** `https:`, `data:`, `memry-file:` — and `C:` on Windows, which we also skip. */
const HAS_SCHEME = /^[a-zA-Z][a-zA-Z\d+\-.]*:/

/**
 * Both separators count: `toMemryFileUrl` rewrites `\` to `/` when it builds the
 * URL, so a ref like `..\..\x.png` would otherwise pass through here as one
 * opaque segment — skipping the `..` checks — and only become a traversal after
 * the guard had already approved it.
 */
const SEPARATOR = /[/\\]/

/**
 * Join a vault-relative directory with a relative ref, collapsing `.` and `..`.
 * Returns null if the ref climbs above the vault root.
 */
function joinWithinVault(dir: string, ref: string): string | null {
  const out: string[] = []
  for (const segment of [...dir.split(SEPARATOR), ...ref.split(SEPARATOR)]) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length > 0 ? out.join('/') : null
}

/**
 * @param url        Raw `props.url` from a BlockNote file/image block.
 * @param notePath   The note's path relative to the vault root (`Folder/Note.md`).
 * @param vaultPath  Absolute path of the open vault.
 * @returns A `memry-file://` URL, or `url` unchanged when it is not a resolvable
 *          vault-relative path.
 */
export function resolveNoteRelativeUrl(
  url: string,
  notePath: string | undefined,
  vaultPath: string | null
): string {
  if (!url || !notePath || !vaultPath) return url
  if (HAS_SCHEME.test(url)) return url
  // A leading separator is ambiguous (vault root? filesystem root? a Windows UNC
  // share, for `\\server\share`?) — don't guess.
  if (url.startsWith('/') || url.startsWith('\\')) return url

  // Refs are commonly percent-encoded (`my%20photo.png`); decode for the disk
  // path, then let toMemryFileUrl re-encode each segment.
  let decoded: string
  try {
    decoded = decodeURIComponent(url)
  } catch {
    decoded = url
  }

  const lastSlash = notePath.lastIndexOf('/')
  const noteDir = lastSlash === -1 ? '' : notePath.slice(0, lastSlash)

  const resolved = joinWithinVault(noteDir, decoded)
  if (!resolved) return url

  return toMemryFileUrl(`${vaultPath.replace(/[/\\]+$/, '')}/${resolved}`)
}

/**
 * The inverse: a vault-relative target written the way `notePath` should carry
 * it. Used when the editor embeds a file the renderer already knows the vault
 * path of (a sidebar drop), where `saveAttachment` — which does this in the main
 * process — is never involved.
 *
 * Restated rather than imported: this is the renderer, and `main/lib/paths.ts`
 * is not importable from here. Both sides are covered by tests over the same
 * cases, the way `FILE_BLOCK_ACCEPT` mirrors the main-process extension list.
 */
export function noteRelativeRef(notePath: string, targetPath: string): string {
  const noteSegments = notePath.split(SEPARATOR).filter(Boolean)
  // Drop the note's own filename: refs are relative to the folder holding it.
  noteSegments.pop()
  const targetSegments = targetPath.split(SEPARATOR).filter(Boolean)

  let shared = 0
  while (
    shared < noteSegments.length &&
    shared < targetSegments.length &&
    noteSegments[shared] === targetSegments[shared]
  ) {
    shared++
  }

  const up = Array(noteSegments.length - shared).fill('..')
  return [...up, ...targetSegments.slice(shared)].join('/')
}
