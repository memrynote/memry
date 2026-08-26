import { createMemrySchema } from '@memry/editor-schema'
import { WikiLink } from '@memry/editor-schema/inline'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'

/**
 * The mobile WebView's BlockNote schema.
 *
 * Built from `@memry/editor-schema` like every other Memry surface, because a
 * node type this schema cannot build is DELETED from the shared Y.Doc by
 * y-prosemirror — a missing spec replicates as data loss, not as a rendering
 * gap. So the base is the headless (React-free) set the main process uses,
 * which is complete by construction, and exactly ONE spec is re-flavoured for
 * a touch surface: `wikiLink`, whose editor DOM carries `data-target` for the
 * tap handler in `wiki-links.ts` (T067).
 *
 * Images are deliberately NOT handled here. Every block that can show a
 * picture — the default `image` block, `inlineImage`, bookmark and embed
 * markers, pasted HTML — renders an `<img>` with a vault-relative `src` the
 * WebView cannot load, so resolution belongs at the DOM level where all of
 * them are visible (`images.ts`). Re-flavouring one spec would fix one of
 * them and leave the rest broken.
 */
export function createMobileEditorSchema() {
  return createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: {
      ...createServerInlineSpecs(),
      wikiLink: WikiLink
    }
  })
}

export type MobileEditorSchema = ReturnType<typeof createMobileEditorSchema>
