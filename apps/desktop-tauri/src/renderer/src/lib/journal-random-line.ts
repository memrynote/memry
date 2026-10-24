/**
 * `{{random-line:Note title}}` in a journal template: one random line from the
 * named note, picked when the day is seeded (issue #3173).
 *
 * Resolved by the desktop shell before the shared token substitution in
 * `@memry/domain-notes/journal`, because it reads another note and draws a
 * random number, neither of which the pure shared module may do.
 *
 * @module lib/journal-random-line
 */

const RANDOM_LINE_TOKEN = /\{\{random-line:([^}]+)\}\}/g

// List bullets, ordered-list numbers, task checkboxes and quote markers are
// structure, not the line's text.
const LINE_PREFIX = /^(?:>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?/

/** The candidate lines of a note body: non-blank, not headings, markers stripped. */
export function noteLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#') && line !== '---')
    .map((line) => line.replace(LINE_PREFIX, '').trim())
    .filter((line) => line !== '')
}

/**
 * Replace every `{{random-line:Title}}` in `content`. `readNote` returns the
 * note body for a title, or null when no note has that title. A token whose
 * note is missing or has no lines stays as written, so the user sees which
 * reference to fix instead of a silently blank line.
 */
export async function resolveRandomLines(
  content: string,
  readNote: (title: string) => Promise<string | null>,
  random: () => number = Math.random
): Promise<string> {
  const titles = new Set<string>()
  for (const match of content.matchAll(RANDOM_LINE_TOKEN)) titles.add(match[1].trim())
  if (titles.size === 0) return content

  const linesByTitle = new Map<string, string[]>()
  for (const title of titles) {
    const body = await readNote(title)
    linesByTitle.set(title, body === null ? [] : noteLines(body))
  }

  return content.replace(RANDOM_LINE_TOKEN, (token, title: string) => {
    const lines = linesByTitle.get(title.trim()) ?? []
    if (lines.length === 0) return token
    return lines[Math.floor(random() * lines.length)]
  })
}
