import { createMemrySchema } from '@memry/editor-schema'
import {
  WikiLink,
  createInlineImageSpec,
  inlineImageSerialization
} from '@memry/editor-schema/inline'
import { createServerBlockSpecs, createServerInlineSpecs } from '@memry/editor-schema/server'
import { requestAsset } from './assets.ts'

/**
 * The mobile WebView's BlockNote schema.
 *
 * Built from `@memry/editor-schema` like every other Memry surface, because a
 * node type this schema cannot build is DELETED from the shared Y.Doc by
 * y-prosemirror — a missing spec replicates as data loss, not as a rendering
 * gap. So the base is the headless (React-free) set the main process uses,
 * which is complete by construction, and only two specs are re-flavoured for a
 * touch surface:
 *
 *   * `wikiLink` — the editor spec, whose DOM carries `data-target`; the tap
 *     handler in `wiki-links.ts` reads it and asks RN to navigate (T067).
 *   * `inlineImage` — resolves its `src` through the `asset-req` bridge round
 *     trip instead of a vault-relative path the WebView cannot read (T072).
 *
 * Everything else keeps the headless render, which emits exactly what
 * `toExternalHTML` emits and therefore round-trips byte-identically.
 */
export function createMobileEditorSchema() {
  return createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: {
      ...createServerInlineSpecs(),
      wikiLink: WikiLink,
      inlineImage: createInlineImageSpec((inlineContent) => {
        // The shared serializer already produces the `<img>` this node writes
        // to disk; only its `src` resolution differs on a device with no vault
        // access, so the element is reused rather than rebuilt.
        const { dom: img } = inlineImageSerialization.toExternalHTML(inlineContent)
        const ref = inlineContent.props.src || ''
        if (ref) {
          img.removeAttribute('src')
          img.setAttribute('data-asset-ref', ref)
          // Placeholder-with-fetch-action until the bytes exist locally: a
          // Wi-Fi-only default means "not downloaded" is a normal state, not
          // an error, and the note must not have to be reopened when the file
          // lands (T072).
          img.classList.add('asset-pending')
          void requestAsset(ref).then((resolved) => {
            if (!resolved) {
              img.classList.add('asset-missing')
              return
            }
            img.classList.remove('asset-pending')
            img.setAttribute('src', resolved)
          })
        }
        return { dom: img }
      })
    }
  })
}

export type MobileEditorSchema = ReturnType<typeof createMobileEditorSchema>
