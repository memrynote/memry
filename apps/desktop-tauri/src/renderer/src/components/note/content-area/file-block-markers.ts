/**
 * The file block's on-disk form now lives in `@memry/editor-schema/blocks`, so
 * the main process writes the exact same marker bytes this editor does. Kept as
 * a re-export because the marker is imported from here all over the renderer.
 */
export {
  serializeFileBlock,
  parseFileBlockMarker,
  type FileBlockProps
} from '@memry/editor-schema/blocks'

/**
 * The `display` prop a new file block starts with. Only a PDF has a display
 * mode, and `embed` is the stored default, so only `link` is ever written.
 */
export function newFileDisplayProps(
  mimeType: string,
  display: 'embed' | 'link' | undefined
): { display?: 'link' } {
  return mimeType === 'application/pdf' && display === 'link' ? { display: 'link' } : {}
}
