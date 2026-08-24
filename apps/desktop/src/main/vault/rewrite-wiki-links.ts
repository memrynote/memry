/**
 * Rewrite `[[…]]` targets in a note body when the note they address is renamed.
 *
 * Wiki-links carry the target's TITLE, nothing else — no id anywhere in the
 * on-disk format — so a rename silently disconnects every inbound link and the
 * next click on `[[Old Title]]` creates a duplicate note (#1711). The fix is
 * the Obsidian model: at rename time, rewrite the stale title inside every
 * source that links to the renamed note. This module is the pure string half
 * of that; `rename-link-rewrite.ts` finds the sources and persists the result.
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
 *
 * Titles match case-insensitively, same as `resolveNoteByTitle`. Returns null
 * when nothing changed so the caller can skip the write entirely — same
 * contract as `rewriteNoteRefsForMove`.
 */

import { splitWikiTarget } from '@memry/shared/wiki-target'

/** `[[target]]` / `[[target|alias]]`; the alias group keeps its `|` prefix. */
const WIKI_LINK_RUN = /\[\[([^\]|]+)(\|[^\]]+)?\]\]/g

function sameTitle(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/**
 * The body with every wiki-link to `oldTitle` re-pointed at `newTitle`, or
 * null when no link matched.
 *
 * @param otherNoteWithTitleExists Whether a note OTHER than the renamed one
 *   currently holds this title — the raw-fallback guard described above.
 */
export function rewriteWikiLinksForRename(
  body: string,
  oldTitle: string,
  newTitle: string,
  otherNoteWithTitleExists: (title: string) => boolean
): string | null {
  const from = oldTitle.trim()
  if (!body || !from || from === newTitle) return null

  let changed = false

  const rewritten = body.replace(
    WIKI_LINK_RUN,
    (run, target: string, aliasWithPipe: string | undefined) => {
      const raw = target.trim()
      if (!raw) return run

      const { note, heading } = splitWikiTarget(raw)
      // `[[#Heading]]` — a same-note link; there is no title to go stale.
      if (!note) return run

      let next: string | null = null
      if (heading !== null) {
        if (sameTitle(note, from)) {
          // Split-first: keep everything from the first `#` on, verbatim.
          next = newTitle + raw.slice(raw.indexOf('#'))
        } else if (sameTitle(raw, from) && !otherNoteWithTitleExists(note)) {
          next = newTitle
        }
      } else if (sameTitle(raw, from)) {
        next = newTitle
      }

      if (next === null) return run
      changed = true
      return `[[${next}${aliasWithPipe ?? ''}]]`
    }
  )

  return changed ? rewritten : null
}
