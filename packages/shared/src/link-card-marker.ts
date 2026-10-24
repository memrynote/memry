import { isRecord } from './is-record'
import {
  DEFAULT_WIKI_LINK_DISPLAY,
  isWikiLinkSize,
  wikiLinkDisplayProps,
  wikiLinkMarkProps,
  type WikiLinkDisplayProps
} from './wiki-link-props'

/**
 * The `<!-- link-card:{…} -->` sidecar line: display settings of a wiki link
 * that is the only content of its paragraph. The line sits directly before the
 * paragraph, like the `align` marker. JSON keys are written in the order `size`,
 * `cover`, `preview`; a key at its default is omitted, `size` only appears as
 * `small` or `medium`, and a link with every default writes no line at all.
 */
export const LINK_CARD_LINE_REGEX = /^<!-- link-card:(\{.*\}) -->$/

/** The block a link-card marker reads and writes, a subset of a BlockNote block. */
export interface LinkCardBlock {
  type?: string
  props: Record<string, unknown>
  content: unknown
}

interface WikiLinkNode {
  type: 'wikiLink'
  props: Record<string, unknown>
}

function isWikiLinkNode(item: unknown): item is WikiLinkNode {
  return isRecord(item) && item.type === 'wikiLink' && isRecord(item.props)
}

const WIKI_LINK_TEXT = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/

function isBlankText(item: unknown): boolean {
  return (
    isRecord(item) && item.type === 'text' && typeof item.text === 'string' && !item.text.trim()
  )
}

/**
 * The block's wiki link when it is a paragraph holding nothing else. Runs of
 * only whitespace beside the link do not count: the `[[` picker inserts the
 * link followed by a space, and a link someone has just added is `[link, " "]`
 * until the note is reopened. Counting that space would hide the settings from
 * a link the editor itself shows as a card.
 */
function soleWikiLinkNode(block: LinkCardBlock): WikiLinkNode | null {
  if (block.type !== 'paragraph' || !Array.isArray(block.content)) return null
  const links = block.content.filter((item) => !isBlankText(item))
  const [only] = links
  if (links.length !== 1) return null
  return isWikiLinkNode(only) ? only : null
}

/**
 * The block's content when it is a paragraph whose text runs, all in one style,
 * read exactly `[[target]]` or `[[target|alias]]`. A seed from the vault file
 * leaves a link as text until the renderer promotes it, so a marker has to be
 * able to claim it there or the settings would be lost on the first open.
 */
function promoteSoleWikiLinkText(block: LinkCardBlock): WikiLinkNode | null {
  if (block.type !== 'paragraph' || !Array.isArray(block.content) || block.content.length === 0) {
    return null
  }
  const runs: Record<string, unknown>[] = []
  for (const run of block.content) {
    if (!isRecord(run) || run.type !== 'text' || typeof run.text !== 'string') return null
    runs.push(run)
  }
  const first = runs[0]
  const styles = isRecord(first.styles) ? first.styles : {}
  const sameStyle = runs.every((run) => JSON.stringify(run.styles ?? {}) === JSON.stringify(styles))
  if (!sameStyle) return null

  const joined = runs.map((run) => run.text).join('')
  const match = joined.match(WIKI_LINK_TEXT)
  const target = match?.[1]?.trim()
  if (!match || !target) return null
  return {
    type: 'wikiLink',
    props: { target, alias: match[2]?.trim() ?? '', ...wikiLinkMarkProps(styles) }
  }
}

/** The marker line a block needs, or null when it is not a sole link or all defaults. */
export function serializeLinkCardMarker(block: LinkCardBlock): string | null {
  const node = soleWikiLinkNode(block)
  if (!node) return null

  const display = wikiLinkDisplayProps(node.props)
  const json: Partial<WikiLinkDisplayProps> = {}
  if (display.size === 'small' || display.size === 'medium') json.size = display.size
  if (display.cover) json.cover = true
  if (display.preview) json.preview = true
  return Object.keys(json).length > 0 ? `<!-- link-card:${JSON.stringify(json)} -->` : null
}

/**
 * Parse a marker line into the settings it names; null for anything that is not
 * a valid marker: bad JSON, an unknown size, a non-boolean flag, or no setting.
 * An unrecognised extra key is ignored so a later build can add one.
 */
export function parseLinkCardMarker(line: string): Partial<WikiLinkDisplayProps> | null {
  const match = line.match(LINK_CARD_LINE_REGEX)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null

  const display: Partial<WikiLinkDisplayProps> = {}
  if ('size' in parsed) {
    if (!isWikiLinkSize(parsed.size)) return null
    display.size = parsed.size
  }
  for (const key of ['cover', 'preview'] as const) {
    if (!(key in parsed)) continue
    if (typeof parsed[key] !== 'boolean') return null
    display[key] = parsed[key]
  }
  return Object.keys(display).length > 0 ? display : null
}

/**
 * Put parsed settings on the block's wiki link. A block that is not a paragraph
 * holding only one link is left exactly as it is.
 */
export function applyLinkCard(block: LinkCardBlock, display: Partial<WikiLinkDisplayProps>): void {
  const node = soleWikiLinkNode(block) ?? promoteSoleWikiLinkText(block)
  if (!node) return
  node.props = { ...node.props, ...DEFAULT_WIKI_LINK_DISPLAY, ...display }
  block.content = [node]
}
