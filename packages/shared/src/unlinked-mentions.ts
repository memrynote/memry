import { maskMarkdownCode, replaceMarkdownComments } from './markdown-code.ts'
import { foldTag } from './tag-fold.ts'

/**
 * Unlinked mentions (#3320): plain text in one note that spells another note's
 * title or alias without linking to it.
 *
 * The match rule is pinned by the `unlinked-mentions` vectors (chapter 12
 * §12.3.1); the Rust core's `domain/unlinked_mentions.rs` implements the same
 * rule over its plain-text bodies:
 *
 * - a name shorter than `MIN_MENTION_NAME_LENGTH` characters is skipped;
 * - each character folds on its own with the tag fold, so matching is
 *   case-insensitive the way names are (`İ` is `i`, final sigma is `σ`);
 * - a match is whole-word: the characters on both sides are not letters,
 *   digits or `_`;
 * - at one position the longest name wins, and the scan resumes after it.
 */
export const MIN_MENTION_NAME_LENGTH = 3

export interface PlainMention {
  /** UTF-16 offsets into the scanned text, `end` exclusive. */
  start: number
  end: number
  /** The text as written in the source. */
  text: string
}

const WORD_CHAR = /[\p{Alphabetic}\p{N}_]/u

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && WORD_CHAR.test(char)
}

/** Every whole-word mention of `names` in plain `text`, in order. */
export function findPlainMentions(text: string, names: readonly string[]): PlainMention[] {
  const seen = new Set<string>()
  const folded: string[][] = []
  for (const name of names) {
    const chars = Array.from(name.trim(), foldTag)
    const key = chars.join('')
    if (chars.length < MIN_MENTION_NAME_LENGTH || seen.has(key)) continue
    seen.add(key)
    folded.push(chars)
  }
  if (folded.length === 0) return []
  folded.sort((a, b) => b.length - a.length)

  const chars = Array.from(text)
  const foldedText = chars.map(foldTag)
  const offsets: number[] = []
  let offset = 0
  for (const char of chars) {
    offsets.push(offset)
    offset += char.length
  }
  offsets.push(offset)

  const out: PlainMention[] = []
  let at = 0
  while (at < chars.length) {
    const name = isWordChar(chars[at - 1])
      ? undefined
      : folded.find(
          (candidate) =>
            candidate.every((char, k) => foldedText[at + k] === char) &&
            !isWordChar(chars[at + candidate.length])
        )
    if (!name) {
      at++
      continue
    }
    const start = offsets[at]
    const end = offsets[at + name.length]
    out.push({ start, end, text: text.slice(start, end) })
    at += name.length
  }
  return out
}

/**
 * Text that is already a link or a URL: never a mention. Bracket runs exclude
 * `[` and a scheme must start its word, so every match
 * attempt stops at the next candidate start and the scan stays linear.
 */
const LINKED_RUNS =
  /!?\[\[[^[\]\n]*\]\]|!?\[[^[\]\n]*\]\([^()\s]*\)|(?<![\p{L}\p{N}+.-])[a-z][a-z0-9+.-]*:\/\/[^\s<>()]*/giu

function maskMarkdown(markdown: string): string {
  const blank = (run: string): string => run.replace(/[^\n]/g, ' ')
  const masked = replaceMarkdownComments(maskMarkdownCode(markdown), blank)
  return masked.replace(LINKED_RUNS, blank)
}

/**
 * Mentions in a markdown body (frontmatter already split off). Code, comments,
 * wiki links, markdown links and URLs are not scanned. Offsets index `markdown`.
 */
export function findUnlinkedMentions(markdown: string, names: readonly string[]): PlainMention[] {
  return findPlainMentions(maskMarkdown(markdown), names).map((mention) => ({
    ...mention,
    text: markdown.slice(mention.start, mention.end)
  }))
}

/**
 * `markdown` with its `ordinal`-th mention turned into `[[title|text]]`
 * (`[[title]]` when the text already spells the title). `null` when there is
 * no such mention, e.g. the body changed since the list was read.
 */
export function linkUnlinkedMention(
  markdown: string,
  names: readonly string[],
  ordinal: number,
  title: string
): string | null {
  const mention = findUnlinkedMentions(markdown, names)[ordinal]
  if (!mention) return null
  const link = mention.text === title ? `[[${title}]]` : `[[${title}|${mention.text}]]`
  return markdown.slice(0, mention.start) + link + markdown.slice(mention.end)
}
