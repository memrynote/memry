/**
 * WikiLink inline content spec for BlockNote.
 *
 * The spec itself lives in @memry/editor-schema so the main process registers
 * the identical node — a spec only one process knows is data loss, not a
 * rendering gap (y-prosemirror deletes elements it cannot build). Re-exported
 * here because the editor's menus, hover cards and normalizers import it from
 * this path.
 */

export {
  WikiLink,
  wikiLinkConfig,
  wikiLinkToText,
  parseWikiLinkText,
  createWikiLinkInlineContent,
  type WikiLinkParts
} from '@memry/editor-schema/inline'
