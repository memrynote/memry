/**
 * The on-disk form of every custom block — the bytes that reach the vault file.
 *
 * This is a contract, not a preference. Write-back byte-compares the serialized
 * document against the file before writing, so a single character of drift here
 * rewrites every note holding one of these blocks, in every vault, on next open.
 * Both processes serialize through these functions for exactly that reason:
 * main's headless spec and the renderer's React spec cannot produce different
 * bytes if neither one owns the format.
 *
 * Each form below is the one already on disk today — see the git history of
 * `callout-block.tsx`, `youtube-embed-block.tsx`, `bookmark-block.tsx` and
 * `file-block-markers.ts`, from which these moved verbatim.
 */

// ---------------------------------------------------------------------------
// callout — `> [!type]` followed by the content, one `> ` per line
// ---------------------------------------------------------------------------

export const CALLOUT_TYPE_VALUES = ['info', 'warning', 'error', 'success'] as const

export type CalloutTypeValue = (typeof CALLOUT_TYPE_VALUES)[number]

/** Matches a callout's opening line: `> [!type]`, with any trailing title text. */
export const CALLOUT_LINE_REGEX = /^> \[!(\w+)\](.*)/

export function serializeCalloutBlock(type: string, contentMarkdown: string): string {
  const lines = contentMarkdown.split('\n').filter((l) => l.length > 0)
  if (lines.length === 0) return `> [!${type}]`
  const quoted = lines.map((line) => `> ${line}`).join('\n')
  return `> [!${type}]\n${quoted}`
}

// ---------------------------------------------------------------------------
// youtubeEmbed / bookmark — an image embed whose alt text names the block
// ---------------------------------------------------------------------------

export const EMBED_BLOCK_REGEX = /!\[embed\]\(([^)]+)\)/g
export const BOOKMARK_BLOCK_REGEX = /!\[bookmark\]\(([^)]+)\)/g

/** A whole line that is nothing but an embed / bookmark marker. */
export const EMBED_LINE_REGEX = /^!\[embed\]\(([^)]+)\)$/
export const BOOKMARK_LINE_REGEX = /^!\[bookmark\]\(([^)]+)\)$/

export function serializeYoutubeEmbed(videoUrl: string): string {
  return `![embed](${videoUrl})`
}

export function serializeBookmark(url: string): string {
  return `![bookmark](${url})`
}

// ---------------------------------------------------------------------------
// file — an HTML comment carrying the props as JSON
// ---------------------------------------------------------------------------

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

/** A whole line that is nothing but a file marker. */
export const FILE_BLOCK_LINE_REGEX = /^<!-- file:\{[^}]+\} -->$/

/**
 * Serialize file block props to markdown marker.
 *
 * Keys are written in a fixed order and the default `width`/`height` (0) are
 * dropped, so a block that was never resized produces the exact same marker
 * bytes as before the width/height props existed.
 */
export function serializeFileBlock(props: FileBlockProps): string {
  return `<!--${fileBlockCommentData(props)}-->`
}

/**
 * The marker's comment data — everything between `<!--` and `-->`, spaces
 * included. The main process needs this half on its own: its headless spec
 * builds a real DOM comment node, which is the only shape BlockNote's
 * HTML→markdown step passes through to the vault file untouched.
 */
export function fileBlockCommentData(props: FileBlockProps): string {
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
  return ` file:${JSON.stringify(payload)} `
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
