/**
 * Ranking for the commands palette. A query matches a command when it is a
 * prefix of the label or a keyword, a prefix of a word in them, or a run of
 * letters that appear in them in order. A command used recently ranks above an
 * equal match, and everything else keeps the order it came in.
 */

export interface RankableCommand {
  readonly id: string
  readonly label: string
  /** Other names to find it by, such as its group's heading. */
  readonly keywords?: readonly string[]
  /** Acts on the active tab, so it sorts above an equal match that does not. */
  readonly contextual?: boolean
}

const PREFIX = 3
const WORD_PREFIX = 2
const SUBSEQUENCE = 1
const RECENT_BOOST = 0.5

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0
  for (const char of haystack) {
    if (char === needle[at]) at += 1
    if (at === needle.length) return true
  }
  return needle.length === 0
}

function scoreText(text: string, query: string, tokens: readonly string[]): number {
  if (text.startsWith(query)) return PREFIX
  const words = text.split(' ')
  if (tokens.every((token) => words.some((word) => word.startsWith(token)))) return WORD_PREFIX
  return isSubsequence(query.replaceAll(' ', ''), text.replaceAll(' ', '')) ? SUBSEQUENCE : 0
}

/** The best match across the label and the keywords, 0 for none. */
function scoreCommand(command: RankableCommand, query: string): number {
  const tokens = query.split(' ')
  const label = scoreText(normalize(command.label), query, tokens)
  const keyword = (command.keywords ?? []).map((text) => scoreText(normalize(text), query, tokens))
  return Math.max(label, ...keyword)
}

/**
 * The commands that match `query`, best first. An empty query matches all and
 * lifts only the recents, most recent first. `recents` is most recent first.
 */
export function rankCommands<T extends RankableCommand>(
  commands: readonly T[],
  query: string,
  recents: readonly string[]
): T[] {
  const needle = normalize(query)
  return commands
    .map((command, index) => {
      const match = needle === '' ? 1 : scoreCommand(command, needle)
      const recent = recents.indexOf(command.id)
      return { command, index, recent, score: match + (recent === -1 ? 0 : RECENT_BOOST) }
    })
    .filter(({ score, recent }) => score > (recent === -1 ? 0 : RECENT_BOOST))
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.command.contextual ?? false) - Number(a.command.contextual ?? false) ||
        (a.recent === -1 ? Infinity : a.recent) - (b.recent === -1 ? Infinity : b.recent) ||
        a.index - b.index
    )
    .map(({ command }) => command)
}
