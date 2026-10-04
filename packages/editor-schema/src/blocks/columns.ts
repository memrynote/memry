/**
 * columnList / column — the Multi-Column Markdown (MCM) region on disk.
 *
 * Obsidian has no columns of its own; the de facto syntax is the
 * Multi-Column Markdown plugin's (github.com/ckRobinson/multi-column-markdown),
 * so that is the syntax Memry reads and writes. A vault shared with Obsidian
 * renders the same columns on both sides, and anywhere else the markers are
 * plain lines around readable content:
 *
 * ```
 * --- start-multi-column: a1b2c3
 * ```column-settings
 * Number of Columns: 2
 * Column Size: [30%, 70%]
 * ```
 *
 * Left column
 *
 * --- end-column ---
 *
 * Right column
 *
 * --- end-multi-column
 * ```
 *
 * Reading accepts every live spelling the plugin accepts: both start tags, all
 * four column breaks, both end tags, the deprecated `===` forms, all three
 * settings fence names, and Pandoc fenced divs (`::: columns` …
 * `::: columnbreak` … `:::`). Writing always produces the form above.
 *
 * The settings block is carried VERBATIM in the `columnList`'s `settings` prop
 * and written back untouched while the column count and widths still match
 * what it says. Border, shadow, alignment and every other MCM setting Memry
 * does not draw therefore survive a Memry edit; only a resize or a column
 * added or removed rewrites the two lines that describe them.
 */

import { createFenceTracker } from '@memry/shared/markdown-fences'

export const COLUMN_REGION_START_PREFIX = '--- start-multi-column:'
export const COLUMN_BREAK_LINE = '--- end-column ---'
export const COLUMN_REGION_END_LINE = '--- end-multi-column'
const SETTINGS_FENCE_OPEN = '```column-settings'
const SETTINGS_FENCE_CLOSE = '```'

const MCM_START_REGEX = /^(?:---|===)\s*(?:start-multi-column|multi-column-start)\s*(?::(.*))?$/i
const MCM_BREAK_REGEX =
  /^(?:---|===)\s*(?:column-end|end-column|column-break|break-column)\s*(?:---|===)?$/i
const MCM_END_REGEX = /^(?:---|===)\s*(?:end-multi-column|multi-column-end)$/i
const SETTINGS_OPEN_REGEX = /^```\s*(?:column-settings|multi-column-settings|settings)\s*$/i
const SETTINGS_CLOSE_REGEX = /^```\s*$/

/**
 * The descriptor after a Pandoc `:::` fence (`''` for a bare closing fence),
 * or null when the line is not one. A function rather than `/^:{3,}\s*(.*?)\s*$/`:
 * that pattern is quadratic on a long run of whitespace, and note content is
 * attacker-reachable through sync.
 */
function pandocFence(line: string): string | null {
  let colons = 0
  while (line[colons] === ':') colons++
  return colons >= 3 ? line.slice(colons).trim() : null
}
const PANDOC_COLUMNS_CLASS_REGEX =
  /^(?:columns|(?:two|three|four|five|six|seven|eight|nine|ten)-?columns)$/i
const PANDOC_COLUMN_BREAK_REGEX = /^\{?\s*\.?columnbreak\s*\}?$/i

const COUNT_KEYS = new Set(['number of columns', 'num of cols', 'col count'])
const SIZE_KEYS = new Set([
  'column size',
  'col size',
  'column width',
  'col width',
  'largest column'
])

/** Columns the editor gives a new or unsized region: every one the same width. */
export const DEFAULT_COLUMN_WIDTH = 1

export interface ColumnRegionSegment {
  kind: 'columns'
  /** The region's MCM id, `''` when the file gave none. */
  regionId: string
  /** The settings fence, verbatim and fences included, or `''` for none. */
  settings: string
  /** Each column's markdown, trimmed of the blank lines at its edges. */
  columns: string[]
}

export interface ColumnMarkdownSegment {
  kind: 'markdown'
  text: string
}

/** Same currency as `ToggleGapSegment`: blank lines BEYOND the one separator. */
export interface ColumnGapSegment {
  kind: 'gap'
  extraLines: number
}

export type ColumnContentSegment = ColumnRegionSegment | ColumnMarkdownSegment | ColumnGapSegment

/**
 * Split markdown into column regions and everything between them.
 *
 * Runs BEFORE the toggle split for the same reason the toggle split runs
 * before the line scanners: a column body holds blank lines, toggles and code
 * fences of its own, and a scanner that saw the region one line at a time
 * would shred it.
 *
 * A region is declined, and stays markdown, when it is unterminated or holds
 * fewer than two columns. An editor column list cannot hold one column, and
 * swallowing the rest of a note into a region its author never closed loses
 * more than it saves.
 */
export function splitMarkdownByColumnRegions(markdown: string): ColumnContentSegment[] {
  const lines = markdown.split('\n')
  const segments: ColumnContentSegment[] = []
  const fence = createFenceTracker()
  let buffer: string[] = []

  // A leading gap is dropped for the reason `splitMarkdownByToggles` gives:
  // assembly writes `\n\n` in front of a gap whether or not anything precedes
  // it, so carrying one at the very start grows the file on every save.
  const pushGap = (blankLines: number): void => {
    if (segments.length > 0 && blankLines > 1) {
      segments.push({ kind: 'gap', extraLines: blankLines - 1 })
    }
  }

  const flushMarkdown = (): void => {
    let first = 0
    while (first < buffer.length && buffer[first].trim() === '') first++
    let afterLast = buffer.length
    while (afterLast > first && buffer[afterLast - 1].trim() === '') afterLast--

    const text = buffer.slice(first, afterLast).join('\n').trim()
    if (text) {
      pushGap(first)
      segments.push({ kind: 'markdown', text })
      pushGap(buffer.length - afterLast)
    } else {
      pushGap(buffer.length)
    }
    buffer = []
  }

  for (let i = 0; i < lines.length; i++) {
    const insideFence = fence.consume(lines[i])
    const region = insideFence ? null : readColumnRegion(lines, i)

    if (!region) {
      buffer.push(lines[i])
      continue
    }

    flushMarkdown()
    segments.push({
      kind: 'columns',
      regionId: region.regionId,
      settings: region.settings,
      columns: region.columns
    })
    // The region's lines are its own; the outer fence tracker never sees them.
    i = region.endIndex
  }

  flushMarkdown()
  return segments
}

interface ColumnRegion {
  regionId: string
  settings: string
  columns: string[]
  endIndex: number
}

function readColumnRegion(lines: readonly string[], start: number): ColumnRegion | null {
  // Matched on the raw line, like the toggle tags: an indented marker belongs
  // to a list item or a code block, and those bytes are not ours to claim.
  const mcm = lines[start].match(MCM_START_REGEX)
  if (mcm) return readMcmRegion(lines, start, (mcm[1] ?? '').trim())

  const pandoc = pandocFence(lines[start])
  if (pandoc) {
    const attributes = parsePandocAttributes(pandoc)
    if (attributes) return readPandocRegion(lines, start, attributes)
  }
  return null
}

function readMcmRegion(
  lines: readonly string[],
  start: number,
  regionId: string
): ColumnRegion | null {
  let i = start + 1
  let settings = ''

  if (i < lines.length && SETTINGS_OPEN_REGEX.test(lines[i].trim())) {
    const close = lines.findIndex((line, index) => index > i && SETTINGS_CLOSE_REGEX.test(line))
    if (close === -1) return null
    settings = lines.slice(i, close + 1).join('\n')
    i = close + 1
  }

  const fence = createFenceTracker()
  const columns: string[] = []
  let current: string[] = []

  for (; i < lines.length; i++) {
    const line = lines[i]
    if (!fence.consume(line)) {
      const trimmed = line.trim()
      if (MCM_BREAK_REGEX.test(trimmed)) {
        columns.push(current.join('\n').trim())
        current = []
        continue
      }
      if (MCM_END_REGEX.test(trimmed)) {
        columns.push(current.join('\n').trim())
        return columns.length >= 2 ? { regionId, settings, columns, endIndex: i } : null
      }
    }
    current.push(line)
  }

  return null
}

interface PandocAttributes {
  regionId: string
  settingsLines: string[]
}

/**
 * The attributes of a Pandoc `:::` opener, or null when it is not a columns
 * div. `::: columns`, `::: twocolumns` and `::: {.three-columns id=x}` all
 * open one. Attributes Memry has no meaning for are kept as MCM settings
 * lines, so the region keeps them once it is written back in MCM syntax.
 */
function parsePandocAttributes(descriptor: string): PandocAttributes | null {
  const braced = descriptor.match(/^\{(.*)\}$/)
  const tokens = (braced ? braced[1] : descriptor).split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null
  if (!braced && tokens.length !== 1) return null

  let isColumns = false
  let regionId = ''
  const settingsLines: string[] = []

  for (const token of tokens) {
    const className = braced ? token.match(/^\.(.+)$/)?.[1] : token
    if (className !== undefined) {
      if (PANDOC_COLUMNS_CLASS_REGEX.test(className)) isColumns = true
      continue
    }
    if (token.startsWith('#')) {
      regionId = token.slice(1)
      continue
    }
    const pair = token.match(/^([^=]+)=(.*)$/)
    if (!pair) continue
    const key = pair[1].toLowerCase()
    const value = pair[2].replace(/^"(.*)"$/, '$1')
    if (key === 'id') regionId = value
    else if (key === 'columngap' || key === 'column-gap')
      settingsLines.push(`Column Spacing: ${value}`)
    // The count is the number of column breaks plus one; a stated count
    // that disagrees would only be rewritten on the next save.
    else if (key !== 'col-count' && key !== 'colcount') settingsLines.push(`${pair[1]}: ${value}`)
  }

  return isColumns ? { regionId, settingsLines } : null
}

function readPandocRegion(
  lines: readonly string[],
  start: number,
  attributes: PandocAttributes
): ColumnRegion | null {
  const fence = createFenceTracker()
  const columns: string[] = []
  const openDivs: ('break' | 'div')[] = []
  let current: string[] = []

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    const div = fence.consume(line) ? null : pandocFence(line)

    if (div === '') {
      const closed = openDivs.pop()
      if (closed === undefined) {
        columns.push(current.join('\n').trim())
        if (columns.length < 2) return null
        const settings =
          attributes.settingsLines.length > 0
            ? [SETTINGS_FENCE_OPEN, ...attributes.settingsLines, SETTINGS_FENCE_CLOSE].join('\n')
            : ''
        return { regionId: attributes.regionId, settings, columns, endIndex: i }
      }
      if (closed === 'break') {
        columns.push(current.join('\n').trim())
        current = []
        continue
      }
    } else if (div) {
      if (PANDOC_COLUMN_BREAK_REGEX.test(div)) {
        openDivs.push('break')
        continue
      }
      openDivs.push('div')
    }
    current.push(line)
  }

  return null
}

function settingsEntries(settings: string): { key: string; value: string; line: string }[] {
  const inner = settings.split('\n').slice(1, -1)
  return inner.map((line) => {
    // indexOf + trim, not a lazy-group regex: same quadratic hazard as above.
    const colon = line.indexOf(':')
    return colon > 0
      ? {
          key: line.slice(0, colon).trim().toLowerCase(),
          value: line.slice(colon + 1).trim(),
          line
        }
      : { key: '', value: '', line }
  })
}

function normalizeWidths(widths: readonly number[]): number[] {
  const valid = widths.map((w) => (Number.isFinite(w) && w > 0 ? w : DEFAULT_COLUMN_WIDTH))
  const mean = valid.reduce((sum, w) => sum + w, 0) / valid.length
  return valid.map((w) => w / mean)
}

/**
 * MCM's named layouts. The plugin sizes them in CSS; the proportions here are
 * the editor's approximation, and only drive display — the setting itself is
 * written back verbatim until the user resizes.
 */
function namedLayoutWidths(name: string, count: number): number[] | null {
  const key = name.toLowerCase()
  if (key === 'standard') return null
  if (count === 2) {
    if (key === 'left' || key === 'first') return [3, 1]
    if (key === 'right' || key === 'second') return [1, 3]
  }
  if (count === 3) {
    if (key === 'left' || key === 'first') return [2, 1, 1]
    if (key === 'center' || key === 'middle' || key === 'second') return [1, 2, 1]
    if (key === 'right' || key === 'third') return [1, 1, 2]
  }
  return null
}

function sizeListWidths(value: string, count: number): number[] | null {
  const list = value.match(/^\[(.*)\]$/)
  if (!list) return null
  const items = list[1].split(',').map((item) => item.trim())
  if (items.length !== count) return null
  const parsed = items.map((item) => item.match(/^(\d+(?:\.\d+)?)\s*([a-z%]*)$/i))
  if (parsed.some((match) => !match)) return null
  // Mixed units (`[200px, 50%]`) have no proportion to read off.
  const units = new Set(parsed.map((match) => match![2].toLowerCase()))
  if (units.size !== 1) return null
  return parsed.map((match) => Number(match![1]))
}

/**
 * Column widths, mean 1, that a region's settings describe for `count`
 * columns. Equal widths when the settings say nothing the editor can draw.
 */
export function columnWidthsFromSettings(settings: string, count: number): number[] {
  const equal = Array.from({ length: count }, () => DEFAULT_COLUMN_WIDTH)
  if (!settings || count < 1) return equal
  const size = settingsEntries(settings).find((entry) => SIZE_KEYS.has(entry.key))
  if (!size) return equal
  const widths = sizeListWidths(size.value, count) ?? namedLayoutWidths(size.value, count)
  return widths ? normalizeWidths(widths) : equal
}

const WIDTH_TOLERANCE = 0.02

function sameWidths(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false
  const na = normalizeWidths(a)
  const nb = normalizeWidths(b)
  return na.every((w, i) => Math.abs(w - nb[i]) <= WIDTH_TOLERANCE)
}

function formatPercent(value: number): string {
  return `${Math.round(value * 10) / 10}%`
}

/**
 * The settings fence to write for a region with these column widths.
 *
 * The stored fence comes back byte-for-byte while it still describes the
 * columns. Otherwise only its count and size lines are rewritten, and every
 * other line — border, shadow, alignment, anything MCM adds later — is kept.
 */
export function columnSettingsFor(settings: string, widths: readonly number[]): string {
  const count = widths.length
  if (settings) {
    const entries = settingsEntries(settings)
    const countEntry = entries.find((entry) => COUNT_KEYS.has(entry.key))
    const statedCount = countEntry ? Number(countEntry.value) : count
    if (statedCount === count && sameWidths(columnWidthsFromSettings(settings, count), widths)) {
      return settings
    }
  }

  const kept = settings
    ? settingsEntries(settings)
        .filter((entry) => !COUNT_KEYS.has(entry.key) && !SIZE_KEYS.has(entry.key))
        .map((entry) => entry.line)
    : []
  const lines = [`Number of Columns: ${count}`]
  const normalized = normalizeWidths(widths)
  if (!normalized.every((w) => Math.abs(w - 1) <= WIDTH_TOLERANCE)) {
    const total = normalized.reduce((sum, w) => sum + w, 0)
    lines.push(
      `Column Size: [${normalized.map((w) => formatPercent((w / total) * 100)).join(', ')}]`
    )
  }
  return [SETTINGS_FENCE_OPEN, ...lines, ...kept, SETTINGS_FENCE_CLOSE].join('\n')
}

/**
 * The MCM id to write. MCM needs one per region and it must be unique within
 * the note; a region created in Memry has none until it is first written, so
 * it is derived from the block id — the same id in the renderer and the main
 * process, because both serialize the same Y.Doc. Once written it is read back
 * into `regionId` and never derived again.
 */
export function columnRegionIdFor(regionId: string, blockId: string | undefined): string {
  if (regionId) return regionId
  const derived = (blockId ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6)
  return derived || 'columns'
}

export function serializeColumnRegion(
  regionId: string,
  settings: string,
  columnBodies: readonly string[]
): string {
  const header = settings
    ? `${COLUMN_REGION_START_PREFIX} ${regionId}\n${settings}`
    : `${COLUMN_REGION_START_PREFIX} ${regionId}`
  const parts = [header]
  columnBodies.forEach((body, index) => {
    if (index > 0) parts.push(COLUMN_BREAK_LINE)
    const trimmed = body.trim()
    if (trimmed) parts.push(trimmed)
  })
  parts.push(COLUMN_REGION_END_LINE)
  return parts.join('\n\n')
}

/**
 * The `columnList` block for a region, each column's markdown parsed by
 * `parseColumn`. Shared by the renderer and the main process so the two build
 * the same tree from the same bytes. A column the parse leaves empty gets one
 * empty paragraph: a column must hold at least one block.
 */
export async function buildColumnListBlock<B>(
  segment: ColumnRegionSegment,
  parseColumn: (markdown: string) => Promise<B[]>,
  emptyParagraph: () => B,
  newId?: () => string
): Promise<B> {
  const widths = columnWidthsFromSettings(segment.settings, segment.columns.length)
  const columns: { type: 'column'; id?: string; props: { width: number }; children: B[] }[] = []
  for (const [index, markdown] of segment.columns.entries()) {
    const children = markdown ? await parseColumn(markdown) : []
    columns.push({
      type: 'column' as const,
      ...(newId ? { id: newId() } : {}),
      props: { width: widths[index] },
      children: children.length > 0 ? children : [emptyParagraph()]
    })
  }
  // SAFETY: `columnList` as column-specs.ts declares it — two string props
  // and `column` children, each holding the blocks of one column. `B` is the
  // caller's block type, which this package cannot name without its schema.
  return {
    type: 'columnList',
    ...(newId ? { id: newId() } : {}),
    props: { regionId: segment.regionId, settings: segment.settings },
    children: columns
  } as unknown as B
}

interface ColumnListLike {
  id?: string
  props: object
  children?: readonly { props: object; children?: readonly unknown[] }[]
}

/**
 * A `columnList` block's region, each column's blocks serialized by
 * `serializeColumn` — the caller's own top-level walk, so toggles, blank-line
 * gaps and markers inside a column are written exactly as on a page.
 */
export async function serializeColumnListBlock<B>(
  block: ColumnListLike,
  serializeColumn: (blocks: B[]) => Promise<string>
): Promise<string> {
  const props = block.props as { regionId?: unknown; settings?: unknown }
  const columns = block.children ?? []
  // A region of one column does not parse back as a region (see
  // `splitMarkdownByColumnRegions`), so its blocks are written as page content.
  if (columns.length < 2) {
    return serializeColumn(columns.flatMap((column) => (column.children ?? []) as B[]))
  }
  const widths = columns.map((column) => {
    const width = (column.props as { width?: unknown }).width
    return typeof width === 'number' ? width : DEFAULT_COLUMN_WIDTH
  })
  const bodies: string[] = []
  for (const column of columns) {
    bodies.push(await serializeColumn((column.children ?? []) as B[]))
  }
  const settings = typeof props.settings === 'string' ? props.settings : ''
  const regionId = typeof props.regionId === 'string' ? props.regionId : ''
  return serializeColumnRegion(
    columnRegionIdFor(regionId, block.id),
    columnSettingsFor(settings, widths),
    bodies
  )
}
