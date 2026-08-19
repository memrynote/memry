/**
 * Build the `resolveFileUrl` BlockNote calls when it mounts a file/image block.
 *
 * Two properties this has to get right, both learned the hard way:
 *
 *  1. BlockNote calls it *once*, while building the block's DOM, and keeps
 *     whatever comes back. So the vault path must be **awaited**, never read off
 *     a hook that fills in later — the editor mount wins that race and the image
 *     stays broken for the life of the block.
 *  2. A note with many images must not fire one vault lookup per image, so the
 *     in-flight promise is cached and reused.
 *
 * A lookup that fails resolves to `null`, which makes the resolver hand the URL
 * back untouched — the same "leave it alone" behaviour as an unresolvable ref,
 * rather than throwing inside the editor.
 */

import { resolveNoteRelativeUrl } from './resolve-note-relative-url'

export function createNoteFileUrlResolver(
  getNotePath: () => string | undefined,
  fetchVaultPath: () => Promise<string | null>,
  /**
   * Where the note's path comes from on the surfaces that mount the editor
   * knowing only the note's id — the journal, a canvas card, a project's home
   * note. Only `pages/note.tsx` passes the path as a prop, and attachments are
   * now written relative to the note wherever they are saved, so without this
   * the image a user just dropped into their journal would render against the
   * renderer's own base URL and 404.
   *
   * Caching is the caller's job: it knows which note the fallback belongs to.
   */
  fetchNotePath?: () => Promise<string | undefined>
): (url: string) => Promise<string> {
  let vaultPath: Promise<string | null> | null = null

  return async (url: string) => {
    const notePath = getNotePath() ?? (await fetchNotePath?.().catch(() => undefined))
    if (!notePath) return url
    if (!vaultPath) vaultPath = fetchVaultPath().catch(() => null)
    return resolveNoteRelativeUrl(url, notePath, await vaultPath)
  }
}
