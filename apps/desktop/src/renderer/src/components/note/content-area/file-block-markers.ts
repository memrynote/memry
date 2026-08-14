/**
 * The file block's on-disk form now lives in `@memry/editor-schema/blocks`, so
 * the main process writes the exact same marker bytes this editor does. Kept as
 * a re-export because the marker is imported from here all over the renderer.
 */
export {
  FILE_BLOCK_REGEX,
  serializeFileBlock,
  parseFileBlockMarker,
  type FileBlockProps
} from '@memry/editor-schema/blocks'
