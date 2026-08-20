import matter from 'gray-matter'
import { replaceWikiLinks } from '@memry/shared/wiki-target'

export type Eol = '\n' | '\r\n'

export interface FrontmatterSplit {
  /**
   * Exact original substring from byte 0 (BOM included) through the closing
   * `---` line and its EOL, or null when the file has no frontmatter.
   * `block + body === raw` always holds, byte-exact.
   */
  block: string | null
  body: string
}

/**
 * Slice the raw frontmatter block ourselves (same `---` delimiters gray-matter
 * uses) so re-emitting it is byte-exact by construction — comments, key order,
 * quoting, CR bytes and BOM all survive. An unclosed block is not frontmatter.
 */
export function splitFrontmatterBlock(raw: string): FrontmatterSplit {
  const bom = raw.charCodeAt(0) === 0xfeff ? 1 : 0
  const rest = bom ? raw.slice(1) : raw
  const firstNl = rest.indexOf('\n')
  if (firstNl === -1) return { block: null, body: raw }
  if (rest.slice(0, firstNl).replace(/\r$/, '') !== '---') return { block: null, body: raw }

  let from = firstNl + 1
  while (from <= rest.length) {
    const nl = rest.indexOf('\n', from)
    const lineEnd = nl === -1 ? rest.length : nl
    if (rest.slice(from, lineEnd).replace(/\r$/, '') === '---') {
      const blockEnd = nl === -1 ? rest.length : nl + 1
      return { block: raw.slice(0, bom + blockEnd), body: rest.slice(blockEnd) }
    }
    if (nl === -1) break
    from = nl + 1
  }
  return { block: null, body: raw }
}

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
 * Interim Obsidian-style emitter for the edited-frontmatter path
 * (spec 05 owns the real one). No keys → no YAML block at all.
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
  // Remove HTML comments in a loop until stable: one pass can re-form `<!-- -->`
  // from the text left on either side of a removed comment.
  let withoutComments = markdown
  let previous: string
  do {
    previous = withoutComments
    withoutComments = withoutComments.replace(/<!--[\s\S]*?-->/g, '') // memry block/colors/file markers + any HTML comment
  } while (withoutComments !== previous)

  return replaceWikiLinks(withoutComments) // wiki link → alias, else the note half
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
