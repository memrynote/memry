/**
 * The main process's entry point into the shared schema.
 *
 * Everything reachable from here runs under Node + jsdom: no React, no
 * renderer imports. What it supplies is the presentation half the package
 * deliberately leaves to each process — except that main never presents
 * anything, so every `render` throws. The parse/`toExternalHTML` halves, which
 * are what actually decide the bytes written to the vault, come from the same
 * modules the renderer uses.
 */

import {
  createHashTagSpec,
  createDateMentionSpec,
  WikiLinkSerializationOnly,
  type MemryInlineSpecs
} from './inline'

export { createServerBlockSpecs } from './blocks/server-specs'

export function createServerInlineSpecs(): MemryInlineSpecs {
  return {
    wikiLink: WikiLinkSerializationOnly,
    hashTag: createHashTagSpec(() => {
      throw new Error('hashTag server spec is serialization-only and must not be rendered')
    }),
    dateMention: createDateMentionSpec(() => {
      throw new Error('dateMention server spec is serialization-only and must not be rendered')
    })
  }
}
