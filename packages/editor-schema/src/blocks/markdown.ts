/**
 * The on-disk form of every custom block — the bytes that reach the vault file.
 *
 * This is a contract, not a preference. Write-back byte-compares the serialized
 * document against the file before writing, so a single character of drift here
 * rewrites every note holding one of these blocks, in every vault, on next open.
 * The renderer serializes through these functions directly. Main cannot: a
 * server spec returns DOM and BlockNote converts that to markdown, so main
 * builds DOM shaped to serialize to the identical bytes. Two implementations
 * that must agree is exactly the drift this package exists to prevent, so the
 * agreement is asserted by test (see `blocknote-converter.test.ts`), not left
 * to reading.
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
 * `-->` anywhere in the payload would close the HTML comment early, splitting
 * the marker and spilling the rest into the note as a paragraph. A file named
 * `a-->b.pdf` is enough. Escaping it as `\u003e` keeps the JSON byte-for-byte
 * equivalent — `JSON.parse` gives the original string back — while removing the
 * only sequence the comment syntax reserves.
 */
function escapeCommentTerminator(json: string): string {
  return json.replace(/-->/g, '--\\u003e')
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
  return ` file:${escapeCommentTerminator(JSON.stringify(payload))} `
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
