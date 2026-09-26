import matter from 'gray-matter'
import { replaceWikiLinks } from '@memry/shared/wiki-target'
import { stripHtmlComments } from '@memry/shared/html-comments'
import { splitFrontmatterBlock } from '@memry/shared/frontmatter-split'

export type Eol = '\n' | '\r\n'

/**
 * The splitter moved to `@memry/shared/frontmatter-split` (T124) so the WebView
 * editor bundle can use the SAME one — it splits a note's create-time `content`
 * itself, and this module cannot travel there because gray-matter is Node-only.
 * Re-exported unchanged: every caller here still imports it from `@memry/app-core`,
 * and chapter 12 §12.4.1's byte-exactness is a property of the function, not of
 * the file it sits in.
 */
export { splitFrontmatterBlock }
export type { FrontmatterSplit } from '@memry/shared/frontmatter-split'

export interface ParsedMarkdownNote {
  frontmatter: Record<string, unknown>
  /** Raw body substring — never trimmed; `rawFrontmatterBlock + content` is the file. */
  content: string
  rawFrontmatterBlock: string | null
  eol: Eol
  hadTrailingNewline: boolean
}

export function parseMarkdownNote(raw: string): ParsedMarkdownNote {
  const { block, body } = splitFrontmatterBlock(raw)
  // The `{}` options bypass gray-matter's content-keyed cache, which would
  // otherwise leak `data` mutations into later parses of identical content.
  const frontmatter = block ? (matter(block, {}).data as Record<string, unknown>) : {}
  return {
    frontmatter,
    content: body,
    rawFrontmatterBlock: block,
    eol: raw.includes('\r\n') ? '\r\n' : '\n',
    hadTrailingNewline: /\r?\n$/.test(raw)
  }
}

export interface SerializeParsedOptions {
  /** Only when true is the frontmatter block re-stringified; otherwise the raw block is emitted verbatim. */
  frontmatterEdited: boolean
}

/**
 * Serialize an existing note back to file content.
 * Unedited parts stay byte-identical: an unedited body (`content ===
 * parsed.content`) is emitted verbatim, an unedited frontmatter block is the
 * raw original substring. An edited body gets its EOLs converted to the
 * file's dominant EOL and the file's final-newline presence re-applied
 * (per-line EOL preservation is out of scope by design).
 */
export function serializeParsedMarkdownNote(
  parsed: Pick<
    ParsedMarkdownNote,
    'frontmatter' | 'content' | 'rawFrontmatterBlock' | 'eol' | 'hadTrailingNewline'
  >,
  content: string,
  options: SerializeParsedOptions
): string {
  const block = options.frontmatterEdited
    ? stringifyFrontmatterBlock(parsed.frontmatter, parsed.eol)
    : (parsed.rawFrontmatterBlock ?? '')

  if (content === parsed.content) {
    return block + content
  }

  let body = stripTrailingNewlines(content.replace(/\r?\n/g, parsed.eol))
  if (parsed.hadTrailingNewline) body += parsed.eol
  return block + body
}

/** Linear-time trailing-newline strip (no backtracking-prone regex). */
function stripTrailingNewlines(value: string): string {
  let end = value.length
  while (end > 0 && value[end - 1] === '\n') {
    end -= 1
    if (end > 0 && value[end - 1] === '\r') end -= 1
  }
  return value.slice(0, end)
}

/**
 * Obsidian-style emitter for the EDITED-frontmatter path. No keys → no YAML
 * block at all.
 *
 * Key order is JavaScript object insertion order and quoting, line width and
 * scalar spelling are whatever js-yaml's defaults produce (gray-matter 4.0.3 →
 * js-yaml 3.15.1: `sortKeys: false`, `lineWidth: 80`, `noCompatMode: false`).
 * That is NOT a policy and callers MUST NOT depend on it: the only byte-level
 * guarantee is the UNEDITED path, where `serializeParsedMarkdownNote` re-emits
 * the original raw block verbatim. Any frontmatter edit may reorder keys, drop
 * comments, re-quote scalars and re-spell a bare date as an ISO timestamp.
 *
 * Specified in docs/protocol/12-note-body-format.md §12.4.
 */
export function stringifyFrontmatterBlock(
  frontmatter: Record<string, unknown>,
  eol: Eol = '\n'
): string {
  const clean = Object.fromEntries(Object.entries(frontmatter).filter(([, v]) => v !== undefined))
  if (Object.keys(clean).length === 0) return ''
  const block = matter.stringify('', clean)
  // matter.stringify appends a newline for the (empty) content — the block
  // must end exactly at the closing delimiter line or every edited-frontmatter
  // save would accrete a blank line.
  const converted = eol === '\n' ? block : block.replace(/\n/g, '\r\n')
  return stripTrailingNewlines(converted) + eol
}

/**
 * Serialize a NEW file. New files get LF endings and a single trailing
 * newline; existing files go through serializeParsedMarkdownNote instead.
 */
export function writeMarkdownNote(frontmatter: Record<string, unknown>, content: string): string {
  // User content never flows into matter.stringify — the block is built from
  // the frontmatter object alone and the body is concatenated as plain text.
  const body = stripTrailingNewlines(content)
  const block = stringifyFrontmatterBlock(frontmatter)
  if (block === '') {
    return body === '' ? '' : body + '\n'
  }
  return body === '' ? block : block + body + '\n'
}

export function wordCount(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean)
  return words.length
}

export function snippet(content: string): string {
  return stripMarkup(content).replace(/\s+/g, ' ').trim().slice(0, 180)
}

function stripMarkup(markdown: string): string {
  // memry block/colors/file markers + any HTML comment
  return replaceWikiLinks(stripHtmlComments(markdown)) // wiki link → alias, else the note half
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '')) // fenced code → inner text
    .replace(/`([^`]+)`/g, '$1') // inline code
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1') // image → alt
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // link → text
    .replace(/^#{1,6}\s+/gm, '') // headings
    .replace(/^>\s?/gm, '') // blockquotes
    .replace(/^\s*[-*+]\s+/gm, '') // bullet markers
    .replace(/^\s*\d+\.\s+/gm, '') // ordered markers
    .replace(/[*_~]{1,3}/g, '') // emphasis/strike
}
