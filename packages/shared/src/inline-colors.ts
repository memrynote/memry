/**
 * Inline text color persistence.
 *
 * BlockNote's markdown pipeline drops inline `styles.textColor` /
 * `styles.backgroundColor` in both directions, so colored selections are
 * persisted as Obsidian-compatible raw HTML: `<span style="color:red">…</span>`.
 *
 * Markdown serializers escape literal `<span>` text inside runs, so both
 * directions go through markdown-inert alphanumeric tokens instead:
 * - serialize: colored runs are wrapped in token runs
 *   (extractInlineColorRuns), serialized normally, then the tokens are
 *   replaced with span tags (restoreInlineColorTokens).
 * - parse: span tags are masked into tokens before the markdown parse
 *   (maskInlineColorSpans), then the tokens are located in the parsed inline
 *   runs and replaced by styles (applyInlineColorTokens).
 *
 * Tokens end (open) / start (close) with punctuation so emphasis markers next
 * to them keep valid CommonMark flanking (`:*em*:` parses, `x*em*x` does not).
 */

export interface InlineColorStyles {
  textColor?: string
  backgroundColor?: string
}

interface StyledText {
  type: string
  text: string
  styles: Record<string, unknown>
}

interface InlineNode {
  type: string
  text?: string
  content?: InlineNode[]
  styles?: Record<string, unknown>
}

interface BlockNode {
  type?: string
  content?: unknown
  children?: BlockNode[]
}

interface TableContent {
  type: 'tableContent'
  rows: Array<{ cells: unknown[] }>
}

const openToken = (index: number): string => `MEMRYICO${index}:`
const CLOSE_TOKEN = ':MEMRYICC;'
const TOKEN_REGEX = /MEMRYICO(\d+):|:MEMRYICC;/g

function pickColorStyles(styles: Record<string, unknown>): InlineColorStyles | null {
  const colors: InlineColorStyles = {}
  if (typeof styles.textColor === 'string' && styles.textColor !== 'default') {
    colors.textColor = styles.textColor
  }
  if (typeof styles.backgroundColor === 'string' && styles.backgroundColor !== 'default') {
    colors.backgroundColor = styles.backgroundColor
  }
  return colors.textColor || colors.backgroundColor ? colors : null
}

// Palette values are plain names; reject anything that could break out of the
// style attribute or the decl list.
function isSafeColorValue(value: string): boolean {
  return value.length > 0 && !/[;"'<>]/.test(value)
}

function buildSpanOpen(colors: InlineColorStyles): string {
  const decls: string[] = []
  if (colors.textColor) decls.push(`color:${colors.textColor}`)
  if (colors.backgroundColor) decls.push(`background-color:${colors.backgroundColor}`)
  return `<span style="${decls.join(';')}">`
}

// ---------------------------------------------------------------------------
// Serialize side
// ---------------------------------------------------------------------------

export function extractInlineColorRuns(blocks: BlockNode[]): {
  blocks: BlockNode[]
  replacements: Map<string, string>
} {
  const replacements = new Map<string, string>()
  let index = 0

  const wrapInline = (items: InlineNode[]): InlineNode[] => {
    let changed = false
    const out: InlineNode[] = []
    // Consecutive runs with identical colors share one span so a parse that
    // split e.g. `**bold** plain` into two runs re-serializes byte-identical.
    let openColors: InlineColorStyles | null = null

    const closeGroup = (): void => {
      if (!openColors) return
      out.push({ type: 'text', text: CLOSE_TOKEN, styles: {} })
      openColors = null
    }

    for (const item of items) {
      if (Array.isArray(item.content)) {
        closeGroup()
        const content = wrapInline(item.content)
        if (content !== item.content) {
          out.push({ ...item, content })
          changed = true
        } else {
          out.push(item)
        }
        continue
      }
      const styles = item.styles
      const colors =
        typeof item.text === 'string' && item.text.length > 0 && styles
          ? pickColorStyles(styles)
          : null
      if (
        !colors ||
        (colors.textColor && !isSafeColorValue(colors.textColor)) ||
        (colors.backgroundColor && !isSafeColorValue(colors.backgroundColor))
      ) {
        closeGroup()
        out.push(item)
        continue
      }
      if (
        !openColors ||
        openColors.textColor !== colors.textColor ||
        openColors.backgroundColor !== colors.backgroundColor
      ) {
        closeGroup()
        const open = openToken(index++)
        replacements.set(open, buildSpanOpen(colors))
        replacements.set(CLOSE_TOKEN, '</span>')
        out.push({ type: 'text', text: open, styles: {} })
        openColors = colors
      }
      const {
        textColor: _t,
        backgroundColor: _b,
        ...rest
      } = styles as InlineColorStyles & Record<string, unknown>
      out.push({ ...item, styles: rest })
      changed = true
    }
    closeGroup()
    return changed ? out : items
  }

  const wrapTable = (content: TableContent): TableContent | null => {
    let changed = false
    const rows = content.rows.map((row) => {
      const cells = row.cells.map((cell) => {
        if (!Array.isArray(cell)) return cell
        const wrapped = wrapInline(cell as InlineNode[])
        if (wrapped !== cell) changed = true
        return wrapped
      })
      return { ...row, cells }
    })
    return changed ? { ...content, rows } : null
  }

  const wrapBlocks = (input: BlockNode[]): BlockNode[] => {
    let changed = false
    const out = input.map((block) => {
      let next = block
      if (Array.isArray(block.content)) {
        const content = wrapInline(block.content as InlineNode[])
        if (content !== block.content) next = { ...next, content }
      } else if ((block.content as TableContent | undefined)?.type === 'tableContent') {
        const table = wrapTable(block.content as TableContent)
        if (table) next = { ...next, content: table }
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        const children = wrapBlocks(block.children)
        if (children !== block.children) next = { ...next, children }
      }
      if (next !== block) changed = true
      return next
    })
    return changed ? out : input
  }

  return { blocks: wrapBlocks(blocks), replacements }
}

export function restoreInlineColorTokens(
  markdown: string,
  replacements: Map<string, string>
): string {
  if (replacements.size === 0) return markdown
  let out = markdown
  for (const [token, html] of replacements) {
    out = out.split(token).join(html)
  }
  return out
}

// ---------------------------------------------------------------------------
// Parse side
// ---------------------------------------------------------------------------

export interface MaskedColorSpan {
  styles: InlineColorStyles
  source: string
}

const SPAN_OPEN_REGEX = /<span style="([^"]*)">/g
const SPAN_CLOSE_REGEX = /<\/span>/g
// Inline code spans: a backtick run, non-backtick content, matching run.
const INLINE_CODE_REGEX = /(`+)[^`]*?\1/g

function parseColorDecls(style: string): InlineColorStyles | null {
  const colors: InlineColorStyles = {}
  for (const decl of style.split(';')) {
    if (!decl.trim()) continue
    const colonIndex = decl.indexOf(':')
    if (colonIndex === -1) return null
    const prop = decl.slice(0, colonIndex).trim()
    const value = decl.slice(colonIndex + 1).trim()
    if (!isSafeColorValue(value)) return null
    if (prop === 'color') colors.textColor = value
    else if (prop === 'background-color') colors.backgroundColor = value
    else return null
  }
  return colors.textColor || colors.backgroundColor ? colors : null
}

export function maskInlineColorSpans(markdown: string): {
  text: string
  spans: MaskedColorSpan[]
} {
  if (!markdown.includes('</span>')) return { text: markdown, spans: [] }

  const spans: MaskedColorSpan[] = []

  const maskSegment = (segment: string): string =>
    segment
      .replace(SPAN_OPEN_REGEX, (source, style: string) => {
        const styles = parseColorDecls(style)
        if (!styles) return source
        spans.push({ styles, source })
        return openToken(spans.length - 1)
      })
      .replace(SPAN_CLOSE_REGEX, CLOSE_TOKEN)

  const maskLine = (line: string): string => {
    // Skip inline code segments so literal span text inside backticks survives.
    let out = ''
    let last = 0
    INLINE_CODE_REGEX.lastIndex = 0
    for (const match of line.matchAll(INLINE_CODE_REGEX)) {
      out += maskSegment(line.slice(last, match.index)) + match[0]
      last = match.index + match[0].length
    }
    return out + maskSegment(line.slice(last))
  }

  let insideFence = false
  let fenceMarker = ''
  const lines = markdown.split('\n').map((line) => {
    const fenceMatch = line.trimStart().match(/^(```+|~~~+)/)
    if (fenceMatch) {
      if (!insideFence) {
        insideFence = true
        fenceMarker = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fenceMarker) {
        insideFence = false
      }
      return line
    }
    return insideFence ? line : maskLine(line)
  })

  // Close tags only matter paired with a masked open; a document with no
  // color-span opens keeps its original text (BlockNote drops bare spans the
  // same way it always has).
  if (spans.length === 0) return { text: markdown, spans: [] }

  return { text: lines.join('\n'), spans }
}

function mergeActive(
  styles: Record<string, unknown>,
  active: InlineColorStyles[]
): Record<string, unknown> {
  if (active.length === 0) return styles
  return Object.assign({}, styles, ...active)
}

function restoreTokensInText(text: string, spans: MaskedColorSpan[]): string {
  return text.replace(TOKEN_REGEX, (match, openIndex: string | undefined) => {
    if (openIndex === undefined) return '</span>'
    return spans[Number(openIndex)]?.source ?? match
  })
}

export function applyInlineColorTokens(blocks: BlockNode[], spans: MaskedColorSpan[]): BlockNode[] {
  const applyInline = (items: InlineNode[], active: InlineColorStyles[]): InlineNode[] => {
    const out: InlineNode[] = []
    for (const item of items) {
      if (Array.isArray(item.content)) {
        out.push({ ...item, content: applyInline(item.content, active) })
        continue
      }
      if (typeof item.text !== 'string') {
        out.push(item)
        continue
      }
      const run = item as unknown as StyledText
      let last = 0
      TOKEN_REGEX.lastIndex = 0
      for (const match of run.text.matchAll(TOKEN_REGEX)) {
        const plain = run.text.slice(last, match.index)
        if (plain) {
          out.push({ ...run, text: plain, styles: mergeActive(run.styles, active) })
        }
        last = match.index + match[0].length
        const openIndex = match[1]
        if (openIndex !== undefined) {
          const span = spans[Number(openIndex)]
          if (span) {
            active.push(span.styles)
          } else {
            // No matching masked span: the text happened to look like a token.
            out.push({ ...run, text: match[0], styles: mergeActive(run.styles, active) })
          }
        } else if (active.length > 0) {
          active.pop()
        }
      }
      const tail = run.text.slice(last)
      if (tail) {
        out.push({ ...run, text: tail, styles: mergeActive(run.styles, active) })
      }
    }
    return out
  }

  const applyTable = (content: TableContent): TableContent => ({
    ...content,
    rows: content.rows.map((row) => ({
      ...row,
      cells: row.cells.map((cell) =>
        Array.isArray(cell) ? applyInline(cell as InlineNode[], []) : cell
      )
    }))
  })

  const applyBlocks = (input: BlockNode[]): BlockNode[] =>
    input.map((block) => {
      let next = block
      if (block.type === 'codeBlock') {
        // Tokens that slipped into code content (e.g. indented code blocks the
        // line-based fence tracking cannot see) are restored verbatim.
        if (Array.isArray(block.content)) {
          next = {
            ...next,
            content: (block.content as InlineNode[]).map((item) =>
              typeof item.text === 'string'
                ? { ...item, text: restoreTokensInText(item.text, spans) }
                : item
            )
          }
        }
      } else if (Array.isArray(block.content)) {
        next = { ...next, content: applyInline(block.content as InlineNode[], []) }
      } else if ((block.content as TableContent | undefined)?.type === 'tableContent') {
        next = { ...next, content: applyTable(block.content as TableContent) }
      }
      if (Array.isArray(block.children) && block.children.length > 0) {
        next = { ...next, children: applyBlocks(block.children) }
      }
      return next
    })

  return spans.length === 0 ? blocks : applyBlocks(blocks)
}
