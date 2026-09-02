import {
  type BlockColors,
  applyTableCellColors,
  extractTableCellColors,
  hasNonDefaultColors,
  parseBlockColorsMarker,
  parseTableCellColorsMarker,
  serializeBlockColorsMarker,
  serializeTableCellColorsMarker
} from './block-colors'

/**
 * The block a sidecar marker describes, narrowed to the two fields a marker can
 * reach: the props a block-level marker writes into, and the content a
 * table-level one walks.
 */
export interface MarkedBlock {
  props: Record<string, unknown>
  content: unknown
}

/** What a parsed marker line does to the block that follows it. */
export type SidecarPatch = (block: MarkedBlock) => void

export type TextAlignment = 'left' | 'center' | 'right' | 'justify'

/** A whole line that is nothing but a text alignment marker. */
export const BLOCK_ALIGN_LINE_REGEX = /^<!-- align:(center|right|justify) -->$/

/**
 * The alignment marker a block needs, or null when its alignment is the default
 * (or absent, or a value outside the enum).
 */
export function serializeBlockAlignMarker(props: { textAlignment?: unknown }): string | null {
  if (typeof props.textAlignment !== 'string') return null
  const marker = `<!-- align:${props.textAlignment} -->`
  return BLOCK_ALIGN_LINE_REGEX.test(marker) ? marker : null
}

/** Parse a text alignment marker line; null when the line is not one. */
export function parseBlockAlignMarker(line: string): Exclude<TextAlignment, 'left'> | null {
  const match = line.match(BLOCK_ALIGN_LINE_REGEX)
  return match ? (match[1] as Exclude<TextAlignment, 'left'>) : null
}

interface SidecarMarker {
  write(block: MarkedBlock): string | null
  read(line: string): SidecarPatch | null
}

const MARKERS_IN_DISK_ORDER: readonly SidecarMarker[] = [
  {
    write: (block) =>
      hasNonDefaultColors(block.props as BlockColors)
        ? serializeBlockColorsMarker(block.props as BlockColors)
        : null,
    read: (line) => {
      const colors = parseBlockColorsMarker(line)
      if (!colors) return null
      return (block) => {
        block.props = { ...block.props, ...colors }
      }
    }
  },
  {
    write: (block) => {
      const cellColors = extractTableCellColors(block.content)
      return cellColors ? serializeTableCellColorsMarker(cellColors) : null
    },
    read: (line) => {
      const cellColors = parseTableCellColorsMarker(line)
      if (!cellColors) return null
      return (block) => applyTableCellColors(block.content, cellColors)
    }
  },
  {
    write: (block) => serializeBlockAlignMarker(block.props),
    read: (line) => {
      const alignment = parseBlockAlignMarker(line)
      if (!alignment) return null
      return (block) => {
        block.props = { ...block.props, textAlignment: alignment }
      }
    }
  }
]

/**
 * The marker lines a block needs in front of it, in on-disk order; empty for a
 * block in every default state.
 */
export function sidecarMarkerLines(block: MarkedBlock): string[] {
  const lines: string[] = []
  for (const marker of MARKERS_IN_DISK_ORDER) {
    const line = marker.write(block)
    if (line !== null) lines.push(line)
  }
  return lines
}

/** The patch `line` applies to the block after it; null leaves the line alone. */
export function parseSidecarMarkerLine(line: string): SidecarPatch | null {
  for (const marker of MARKERS_IN_DISK_ORDER) {
    const patch = marker.read(line)
    if (patch) return patch
  }
  return null
}
