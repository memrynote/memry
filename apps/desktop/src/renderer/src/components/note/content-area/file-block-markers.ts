export interface FileBlockProps {
  url: string
  name: string
  size: number
  mimeType: string
}

/**
 * Regex to match file block markers in markdown
 * Format: <!-- file:{"url":"...","name":"...","size":123,"mimeType":"..."} -->
 */
export const FILE_BLOCK_REGEX = /<!-- file:(\{[^}]+\}) -->/g

/**
 * Serialize file block props to markdown marker
 */
export function serializeFileBlock(props: FileBlockProps): string {
  return `<!-- file:${JSON.stringify(props)} -->`
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
