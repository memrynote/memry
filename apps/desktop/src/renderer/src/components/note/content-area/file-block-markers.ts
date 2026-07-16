export interface FileBlockProps {
  url: string
  name: string
  size: number
  mimeType: string
  /**
   * User-set display width in px for the inline PDF preview. `0`/undefined means
   * "use the default width" and is omitted from the marker so legacy markers stay
   * byte-for-byte identical on re-save.
   */
  width?: number
}

/**
 * Regex to match file block markers in markdown
 * Format: <!-- file:{"url":"...","name":"...","size":123,"mimeType":"...","width":720} -->
 */
export const FILE_BLOCK_REGEX = /<!-- file:(\{[^}]+\}) -->/g

/**
 * Serialize file block props to markdown marker.
 *
 * Keys are written in a fixed order and the default `width` (0) is dropped, so a
 * block that was never resized produces the exact same marker bytes as before
 * the width prop existed.
 */
export function serializeFileBlock(props: FileBlockProps): string {
  const payload: FileBlockProps = {
    url: props.url,
    name: props.name,
    size: props.size,
    mimeType: props.mimeType
  }
  if (typeof props.width === 'number' && props.width > 0) {
    payload.width = props.width
  }
  return `<!-- file:${JSON.stringify(payload)} -->`
}

/**
 * Parse file block marker from markdown
 */
export function parseFileBlockMarker(marker: string): FileBlockProps | null {
  const match = marker.match(/<!-- file:(\{[^}]+\}) -->/)
  if (!match) return null
  try {
    return JSON.parse(match[1])
  } catch {
    return null
  }
}
