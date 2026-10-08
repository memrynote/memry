/**
 * Rewrite `[[…]]` targets in a note body when the note they address is renamed
 * or moved.
 *
 * Wiki-links carry the target's title or path, never an id, so a rename silently disconnects every inbound link and the
 * next click on `[[Old Title]]` creates a duplicate note (#1711). The fix is
 * the Obsidian model: at rename time, rewrite the stale title inside every
 * source that links to the renamed note. This module is the pure string half
 * of that; the desktop's `rename-link-rewrite.ts` and the CLI's notes service
 * find the sources and persist the result.
 *
 * Which occurrences are rewritten mirrors `resolveWikiTarget`'s split-first
 * order exactly, because a rewrite must only touch links that RESOLVED to the
 * renamed note:
 *
 *  - `[[Old]]`            → `[[New]]`
 *  - `[[Old#Heading]]`    → `[[New#Heading]]` — the heading half (everything
 *    after the first `#`, nested segments included) is kept byte-for-byte.
 *  - `[[Old|alias]]`      → `[[New|alias]]` — the alias is the label the user
 *    chose and is never touched, so the visible text does not change.
 *  - A title that itself contains `#` (`[[Sprint #4]]`) is matched against the
 *    raw target, but only when no OTHER note claims the split half: split
 *    resolution wins over the raw fallback, so if a note titled `Sprint`
 *    exists, `[[Sprint #4]]` was never a link to `Sprint #4` and is left alone.
 *  - `[[#Heading]]` addresses the note it sits in and is never rewritten.
 *  - `[[Folder/Old]]` names the note by path, so it changes when the note or a
 *    folder above it moves or the note is renamed: `[[Folder/New#Heading]]`.
 *
 * Titles match case-insensitively, same as `resolveNoteByTitle`. Returns null
 * when nothing changed so the caller can skip the write entirely — same
 * contract as `rewriteNoteRefsForMove`.
 */

import { splitWikiTarget, wikiPathStem } from './wiki-target.ts'

/** `[[target]]` / `[[target|alias]]`; the alias group keeps its `|` prefix. */
const WIKI_LINK_RUN = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g

function sameTitle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The two ways a link can name a note: its title and its path stem (`noteLinkStem`). */
export interface WikiLinkNames {
  title: string
  pathStem: string
}

/**
 * The body with every wiki-link to the note once named `from` re-pointed at
 * `to`, or null when no link matched.
 *
 * Title-form links follow the title; path-form links (`[[Folder/Note]]`, see
 * `wikiPathStem`) follow the path stem, matched case-insensitively. A leading
 * `/`, the heading half and the alias are kept byte-for-byte.
 *
 * @param otherNoteWithTitleExists Whether a note OTHER than the renamed one
 *   currently holds this title — the raw-fallback guard described above.
 */
export function rewriteWikiLinksToNote(
  body: string,
  from: WikiLinkNames,
  to: WikiLinkNames,
  otherNoteWithTitleExists: (title: string) => boolean
): string | null {
  const fromTitle = from.title.trim()
  const titleChanged = fromTitle !== '' && fromTitle !== to.title
  const stemChanged = from.pathStem !== '' && from.pathStem !== to.pathStem
  if (!body || (!titleChanged && !stemChanged)) return null

  let changed = false

  const rewritten = body.replace(
    WIKI_LINK_RUN,
    (run, target: string, aliasWithPipe: string | undefined) => {
      const raw = target.trim()
      if (!raw) return run

      const { note, heading } = splitWikiTarget(raw)
      // `[[#Heading]]` — a same-note link; there is no title to go stale.
      if (!note) return run

      const suffix = heading !== null ? raw.slice(raw.indexOf('#')) : ''
      const stem = wikiPathStem(note)
      let next: string | null = null
      if (stem !== null) {
        if (stemChanged && sameTitle(stem, from.pathStem)) {
          next = (note.startsWith('/') ? '/' : '') + to.pathStem + suffix
        }
      } else if (!titleChanged) {
        return run
      } else if (heading !== null) {
        if (sameTitle(note, fromTitle)) {
          // Split-first: keep everything from the first `#` on, verbatim.
          next = to.title + suffix
        } else if (sameTitle(raw, fromTitle) && !otherNoteWithTitleExists(note)) {
          next = to.title
        }
      } else if (sameTitle(raw, fromTitle)) {
        next = to.title
      }

      if (next === null) return run
      changed = true
      return `[[${next}${aliasWithPipe ?? ''}]]`
    }
  )

  return changed ? rewritten : null
}
