/**
 * Shared helpers for embedding a saved vault attachment into note markdown.
 *
 * Importers save bytes via `saveAttachment` (which returns a `memry-file://`
 * URL) and must splice a reference into the markdown body. Two rules every
 * importer needs to get right:
 *
 *  1. The URL is percent-encoded so a filename with spaces/parens does not break
 *     markdown link parsing (`![](a b.png)` truncates at the space). The
 *     `memry-file` protocol handler decodes it again via `decodeURIComponent`.
 *  2. Images embed inline (`![](url)`); every other file renders as a clickable
 *     file block via the renderer's `<!-- file:{...} -->` marker so it can be
 *     opened inside Memry instead of showing a broken image.
 */

import type { AttachmentResult } from '../../vault/attachments'
// Single source in `@memry/editor-schema` since the move-time ref rewrite (which
// must apply the identical encoding) went shared for the CLI's `notes move`.
import { encodeAttachmentUrl } from '@memry/editor-schema/note-refs'

export { encodeAttachmentUrl }

/**
 * Renderer file-block marker (kept in sync with renderer
 * `content-area/file-block-markers.ts`). Must sit alone on its own line and
 * contain no literal `}` for the renderer's line regex to match.
 */
export function serializeFileBlockMarker(result: AttachmentResult): string {
  const props = {
    url: result.path ?? '',
    // The display name is the source filename, which may legitimately contain
    // braces; a literal `}` here would end the marker early and leave the raw
    // comment visible in the note.
    name: (result.name ?? '').replace(/[{}]/g, ''),
    size: result.size ?? 0,
    mimeType: result.mimeType ?? 'application/octet-stream'
  }
  return `<!-- file:${JSON.stringify(props)} -->`
}

/**
 * Markdown for a saved attachment: an inline image embed for images, otherwise a
 * clickable file block. Returns null if the save did not produce a usable path.
 */
export function attachmentMarkdown(result: AttachmentResult): string | null {
  if (!result.success || !result.path) return null
  if (result.type === 'image') {
    // Use the original filename as alt text (mirrors manual image embeds); strip
    // brackets so the name can't break the `![alt](url)` syntax.
    const alt = (result.name ?? '').replace(/[[\]]/g, '')
    return `![${alt}](${encodeAttachmentUrl(result.path)})`
  }
  return serializeFileBlockMarker(result)
}
