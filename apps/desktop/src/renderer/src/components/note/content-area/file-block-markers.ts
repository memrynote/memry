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
  /**
   * User-set crop height in px for the inline PDF preview. `0`/undefined means
   * "fit the first page" (no crop) and is omitted from the marker, so markers
   * that were never height-resized stay byte-for-byte identical on re-save.
   */
  height?: number
  /**
   * Alignment of the embed within the note column. `'left'` is the default and is
   * omitted from the marker so markers that were never aligned stay byte-identical.
   */
  align?: 'left' | 'center' | 'right'
}

/**
 * Regex to match file block markers in markdown
 * Format: <!-- file:{"url":"...","name":"...","size":123,"mimeType":"...","width":720} -->
 */
export const FILE_BLOCK_REGEX = /<!-- file:(\{[^}]+\}) -->/g

/**
 * Serialize file block props to markdown marker.
 *
 * Keys are written in a fixed order and the default `width`/`height` (0) are
 * dropped, so a block that was never resized produces the exact same marker
 * bytes as before the width/height props existed.
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
  if (typeof props.height === 'number' && props.height > 0) {
    payload.height = props.height
  }
  if (props.align && props.align !== 'left') {
    payload.align = props.align
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
