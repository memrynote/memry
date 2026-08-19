/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Block } from '@blocknote/core'
import { splitWikiTarget } from '@memry/shared/wiki-target'
import type { HeadingInfo } from './types'
import { createWikiLinkInlineContent, hasWikiLinkMarks } from './wiki-link'

// =============================================================================
// HEADING EXTRACTION
// =============================================================================

export function extractHeadings(blocks: Block[]): HeadingInfo[] {
  const headings: HeadingInfo[] = []
  let position = 0

  function processBlock(block: Block): void {
    if (block.type === 'heading') {
      const level = (block.props?.level as 1 | 2 | 3 | 4 | 5 | 6) || 1
      const text = Array.isArray(block.content)
        ? block.content
            .map((item) => {
              if (typeof item === 'string') return item
              if (item && typeof item === 'object' && 'text' in item) return item.text
              return ''
            })
            .join('')
        : ''

      if (text.trim()) {
        headings.push({
          id: block.id,
          text: text.trim(),
          level,
          position: position * 40
        })
      }
      position++
    }

    if (block.children && Array.isArray(block.children)) {
      block.children.forEach((child) => processBlock(child as Block))
    }
  }

  blocks.forEach((block) => processBlock(block))
  return headings
}

// =============================================================================
// WIKI LINK UTILITIES
// =============================================================================

export const WIKI_LINK_PATTERN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

export function splitWikiLinkQuery(query: string): { search: string; alias: string } {
  const [rawTarget, rawAlias] = query.split('|', 2)
  return {
    search: rawTarget?.trim() ?? '',
    alias: rawAlias?.trim() ?? ''
  }
}

export interface WikiLinkQueryParts {
  /** The whole target as typed, `#` and all — what the note list searches on. */
  search: string
  /** The note half of `note#heading`; equal to `search` when no `#` was typed. */
  note: string
  /** The heading half: `null` when no `#` was typed, `''` immediately after one. */
  heading: string | null
  alias: string
}

/**
 * `Note#Heading|alias` → its three parts.
 *
 * `#` binds tighter than `|` because that is the order the grammar reads in,
 * and `search` is kept alongside the split so the caller can fall back to it.
 * That fallback is not optional: `#` is legal in a note title, so `Sprint #4`
 * splits into note `Sprint` + heading `4`, and only an EXACT match on the note
 * half may switch the menu into heading mode — everything else keeps searching
 * titles for the raw string, exactly as before.
 */
export function parseWikiLinkQuery(query: string): WikiLinkQueryParts {
  const { search, alias } = splitWikiLinkQuery(query)
  const { note, heading } = splitWikiTarget(search)
  return { search, note, heading, alias }
}

/**
 * Whether an alias is one the heading picker wrote rather than one a person did.
 *
 * The two are indistinguishable on disk — the alias is the ONLY channel a
 * display name survives a markdown round trip in, so a heading link's label and
 * a hand-written one are the same bytes. The test is therefore structural: an
 * alias that is exactly its own target's heading text is derived, and follows
 * the heading when the link is retargeted. Anything else is the user's words.
 */
export function isDerivedAlias(target: string, alias: string): boolean {
  if (!alias) return false
  const { heading } = splitWikiTarget(target)
  return heading !== null && heading === alias
}

export interface WikiLinkAliasItem {
  type: string
  /** Heading rows: the heading text, which is also the row's label. */
  title: string
  alias?: string
}

/**
 * The display name a picked suggestion should carry, highest priority first:
 *
 * 1. What was typed after `|` in the query — the user just wrote it.
 * 2. The alias already sitting in the raw `[[…]]` run, when it is not derived.
 *    That is where an edited chip's own label lives, and where "link this
 *    selection" parks the selected text; neither reaches the query, because the
 *    caret sits before the `|`.
 * 3. A heading row labels itself with its heading text, so `[[A#B]]` reads `B`
 *    rather than `A#B` (#1563 D2). Note rows deliberately do NOT: their target
 *    may legitimately BE a title carrying a `#` (`Sprint #4`), and nothing here
 *    can tell those apart — which is also why this is decided when the link is
 *    written and never derived at render time.
 */
export function pickAlias(
  item: WikiLinkAliasItem,
  run: { target: string; alias: string } | null
): string {
  const typed = item.alias?.trim()
  if (typed) return typed

  if (run) {
    const carried = run.alias.trim()
    if (carried && !isDerivedAlias(run.target, carried)) return carried
  }

  return item.type === 'heading' ? item.title : ''
}

function createStyledText(
  text: string,
  styles: Record<string, boolean | string>
): { type: string; text: string; styles: Record<string, boolean | string> } {
  return { type: 'text', text, styles }
}

export function splitTextWithWikiLinks(
  text: string,
  styles?: Record<string, boolean | string>
): { segments: Array<string | Record<string, unknown>>; didChange: boolean } {
  const segments: Array<string | Record<string, unknown>> = []
  const pattern = new RegExp(WIKI_LINK_PATTERN)
  let didChange = false
  let lastIndex = 0
  let match: RegExpExecArray | null

  // #1439, the narrowing. A marked run promotes ONLY when the link is the whole
  // of it. `**[[A]]**` becomes a node carrying `bold`, which serializes back to
  // `**[[A]]**`; `~~Cancelled: [[A]]~~` does not promote at all and stays
  // literal text inside the strike run.
  //
  // Splitting a marked run is what makes the bytes unrepresentable: the node
  // emits its own `<s>`/`<strong>` wrapper, and BlockNote merges adjacent
  // identical marks across text runs but not across an element boundary. The
  // result is `~~Cancelled: ~~~~[[A]]~~`, which GFM cannot parse (a closing `~~`
  // may not follow whitespace) and which grows by four characters on every pass.
  // The cost of declining is one missing link chip inside a marked sentence;
  // the file, which is the thing the user owns, is left exactly as written.
  const wholeRunOnly = hasWikiLinkMarks(styles)

  while ((match = pattern.exec(text)) !== null) {
    const [full, rawTarget, rawAlias] = match
    const target = rawTarget?.trim()
    const alias = rawAlias?.trim() ?? ''

    if (!target) {
      continue
    }

    // `full.length === text.length` alone implies the match starts at 0, so
    // that is the whole test: does this link cover the entire styled run?
    if (wholeRunOnly && full.length !== text.length) {
      return { segments: [createStyledText(text, styles ?? {})], didChange: false }
    }

    if (match.index > lastIndex) {
      const before = text.slice(lastIndex, match.index)
      if (before) {
        segments.push(styles ? createStyledText(before, styles) : before)
      }
    }

    // The run's marks go WITH the link. A custom inline node has no `styles`
    // field in BlockNote's data model, so before #1439 they stopped here: the
    // surrounding text segments kept them, the link silently did not, and
    // `**[[A]]**` became `[[A]]` on disk the first time the note was opened.
    segments.push(createWikiLinkInlineContent(target, alias, styles))
    didChange = true
    lastIndex = match.index + full.length
  }

  if (!didChange) {
    return { segments: [styles ? createStyledText(text, styles) : text], didChange: false }
  }

  const trailing = text.slice(lastIndex)
  if (trailing) {
    segments.push(styles ? createStyledText(trailing, styles) : trailing)
  }

  return { segments, didChange: true }
}

export function normalizeInlineContent(content: string | Array<any>): {
  content: string | Array<any>
  didChange: boolean
} {
  if (typeof content === 'string') {
    const { segments, didChange } = splitTextWithWikiLinks(content)
    if (!didChange) return { content, didChange: false }
    return { content: segments, didChange: true }
  }

  if (!Array.isArray(content)) {
    return { content, didChange: false }
  }

  let didChange = false
  const next: Array<any> = []

  for (const item of content) {
    if (typeof item === 'string') {
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item as any)
      }
      continue
    }

    if (item?.type === 'text') {
      const styles = item.styles ?? {}
      const { segments, didChange: itemChanged } = splitTextWithWikiLinks(item.text ?? '', styles)
      if (itemChanged) {
        didChange = true
        next.push(...segments)
      } else {
        next.push(item)
      }
      continue
    }

    if (item?.type === 'wikiLink') {
      next.push(item)
      continue
    }

    next.push(item)
  }

  return { content: didChange ? next : content, didChange }
}

export function normalizeTableContent(tableContent: any): { content: any; didChange: boolean } {
  if (!tableContent?.rows) {
    return { content: tableContent, didChange: false }
  }

  let didChange = false
  const rows = tableContent.rows.map((row: any) => {
    let rowChanged = false
    const cells = row.cells.map((cell: any) => {
      if (Array.isArray(cell)) {
        const normalized = normalizeInlineContent(cell)
        if (normalized.didChange) {
          rowChanged = true
        }
        return normalized.content
      }

      if (cell?.type === 'tableCell') {
        const normalized = normalizeInlineContent(cell.content ?? '')
        if (normalized.didChange) {
          rowChanged = true
          return { ...cell, content: normalized.content }
        }
      }

      return cell
    })

    if (rowChanged) {
      didChange = true
      return { ...row, cells }
    }
    return row
  })

  if (!didChange) {
    return { content: tableContent, didChange: false }
  }

  return { content: { ...tableContent, rows }, didChange: true }
}

export interface NormalizeWikiLinksOptions {
  /**
   * The block holding the caret, left alone.
   *
   * Promotion is what makes a wiki link a chip, and normally that is exactly
   * right. It is wrong for the one block the user is editing IN: un-promoting a
   * chip (`wiki-link-edit-plugin.ts`) leaves real `[[…]]` text under the caret,
   * which this would promote straight back on the next keystroke — through a
   * whole-document `replaceBlocks`, under a caret, mid-word. Skipping the whole
   * block is coarser than skipping the run, and enough: leaving the block
   * promotes it, and so does the plugin the moment the caret leaves the run.
   */
  skipBlockId?: string
}

export function normalizeWikiLinks(
  blocks: Block[],
  options?: NormalizeWikiLinksOptions
): { blocks: Block[]; didChange: boolean } {
  const blockStr = JSON.stringify(blocks)
  if (!blockStr.includes('[[')) {
    return { blocks, didChange: false }
  }

  let didChange = false

  const nextBlocks = blocks.map((block) => {
    if (block.type === 'codeBlock') {
      return block
    }

    let blockChanged = false
    let nextBlock: Block = block

    // Children are still walked: a sibling block nested under the caret's block
    // is a different block, and its links promote as usual.
    if (block.content && block.id !== options?.skipBlockId) {
      if (typeof block.content === 'string' || Array.isArray(block.content)) {
        const normalized = normalizeInlineContent(block.content as any)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content as any }
        }
      } else if ((block.content as any).type === 'tableContent') {
        const normalized = normalizeTableContent(block.content)
        if (normalized.didChange) {
          blockChanged = true
          nextBlock = { ...nextBlock, content: normalized.content }
        }
      }
    }

    if (block.children?.length) {
      const normalizedChildren = normalizeWikiLinks(block.children as Block[], options)
      if (normalizedChildren.didChange) {
        blockChanged = true
        nextBlock = { ...nextBlock, children: normalizedChildren.blocks }
      }
    }

    if (blockChanged) {
      didChange = true
    }

    return blockChanged ? nextBlock : block
  })

  return { blocks: didChange ? nextBlocks : blocks, didChange }
}

// =============================================================================
// MARKDOWN UTILITIES
// =============================================================================

export function normalizeMarkdownHardBreaks(markdown: string): string {
  const lines = markdown.split('\n')
  const normalized: string[] = []
  let inCodeBlock = false

  for (const line of lines) {
    let lineBody = line
    let lineEnding = ''

    if (lineBody.endsWith('\r')) {
      lineEnding = '\r'
      lineBody = lineBody.slice(0, -1)
    }

    const trimmed = lineBody.trimStart()
    const isFence = trimmed.startsWith('```') || trimmed.startsWith('~~~')

    if (isFence) {
      inCodeBlock = !inCodeBlock
      normalized.push(lineBody + lineEnding)
      continue
    }

    if (!inCodeBlock) {
      const match = lineBody.match(/(\\+)$/)
      if (match && match[1].length % 2 === 1) {
        const nextLine = lineBody.slice(0, -1)
        if (nextLine.trim() === '') {
          continue
        }
        normalized.push(nextLine + lineEnding)
        continue
      }
    }

    normalized.push(lineBody + lineEnding)
  }

  return normalized.join('\n')
}
