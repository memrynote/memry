export interface BlockColors {
  textColor?: string
  backgroundColor?: string
}

/**
 * Regex to match block color markers in markdown (full line only)
 * Format: <!-- colors:{"textColor":"red","backgroundColor":"blue"} -->
 * The marker applies to the block that immediately follows it.
 */
export const BLOCK_COLORS_LINE_REGEX = /^<!-- colors:(\{[^}]*\}) -->$/

/**
 * True when block props carry a non-default text or background color
 */
export function hasNonDefaultColors(props: BlockColors): boolean {
  return (
    (props.textColor !== undefined && props.textColor !== 'default') ||
    (props.backgroundColor !== undefined && props.backgroundColor !== 'default')
  )
}

/**
 * Serialize non-default block colors to a markdown marker line
 */
export function serializeBlockColorsMarker(props: BlockColors): string {
  const colors: BlockColors = {}
  if (props.textColor !== undefined && props.textColor !== 'default') {
    colors.textColor = props.textColor
  }
  if (props.backgroundColor !== undefined && props.backgroundColor !== 'default') {
    colors.backgroundColor = props.backgroundColor
  }
  return `<!-- colors:${JSON.stringify(colors)} -->`
}

/**
 * Parse a block color marker line; null when the line is not a valid marker
 */
export function parseBlockColorsMarker(line: string): BlockColors | null {
  const match = line.match(BLOCK_COLORS_LINE_REGEX)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}
