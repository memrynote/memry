import { createMemrySchema } from '@memry/editor-schema'
import { createTouchBlockSpecs } from './blocks.ts'
import { createTouchInlineSpecs } from './inline.ts'

/**
 * The mobile WebView's BlockNote schema.
 *
 * Built from `@memry/editor-schema` like every other Memry surface, because a
 * node type this schema cannot build is DELETED from the shared Y.Doc by
 * y-prosemirror — a missing spec replicates as data loss, not as a rendering
 * gap. So registration is complete by construction: the configs, the `parse`
 * rules and the `toExternalHTML` halves are the shared package's, and mobile
 * cannot carry a node type desktop and the main process lack.
 *
 * What it supplies is the presentation half, and it supplies all of it. Every
 * custom block and every custom inline type has a touch `render` here
 * (`blocks.ts`, `inline.ts`); before that, they fell through to the main
 * process's SERIALIZATION DOM, which is chosen for what BlockNote's
 * HTML-to-markdown step turns it into and is invisible or broken on a phone —
 * a file block was an HTML comment, a callout printed a literal `[!info]`, and
 * bookmarks and embeds were remote `<img>` the CSP blocks.
 *
 * Images are deliberately NOT handled here. Every block that can show a
 * picture — the default `image` block, `inlineImage`, pasted HTML — renders an
 * `<img>` with a vault-relative `src` the WebView cannot load, so resolution
 * belongs at the DOM level where all of them are visible (`images.ts`). That
 * is why `inlineImage` still writes a raw vault-relative `src`.
 */
export function createMobileEditorSchema() {
  return createMemrySchema({
    blocks: createTouchBlockSpecs(),
    inline: createTouchInlineSpecs()
  })
}

export type MobileEditorSchema = ReturnType<typeof createMobileEditorSchema>
