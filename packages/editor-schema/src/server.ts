/**
 * The main process's entry point into the shared schema.
 *
 * Everything reachable from here runs under Node + jsdom: no React, no
 * renderer imports. What it supplies is the presentation half the package
 * deliberately leaves to each process — and for main that half must emit
 * exactly what `toExternalHTML` emits.
 *
 * It is tempting to make these renders throw, on the reasoning that a
 * serialization-only schema never presents anything. That is wrong: BlockNote
 * serializes inline content inside a TABLE through `render`, not
 * `toExternalHTML`. A throwing render made `yDocToMarkdown` return null for
 * any note holding a wiki link, hash tag or date mention in a table, which
 * stopped that note's write-back completely; and leaving the editor's rich
 * `linkMention` render in place rewrote `((mention:…))` as a plain markdown
 * link, losing the token and its metadata from disk.
 */

import {
  createHashTagSpec,
  createDateMentionSpec,
  createInlineImageSpec,
  inlineImageSerialization,
  dateMentionSerialization,
  hashTagSerialization,
  LinkMentionSerializationOnly,
  WikiLinkSerializationOnly,
  type MemryInlineSpecs
} from './inline'

export { createServerBlockSpecs } from './blocks/server-specs'

export function createServerInlineSpecs(): MemryInlineSpecs {
  return {
    wikiLink: WikiLinkSerializationOnly,
    linkMention: LinkMentionSerializationOnly,
    hashTag: createHashTagSpec((inlineContent) =>
      hashTagSerialization.toExternalHTML(inlineContent)
    ),
    dateMention: createDateMentionSpec((inlineContent) =>
      dateMentionSerialization.toExternalHTML(inlineContent)
    ),
    inlineImage: createInlineImageSpec((inlineContent) =>
      inlineImageSerialization.toExternalHTML(inlineContent)
    )
  }
}
