/**
 * The one rule that makes a custom inline node survive a TABLE CELL.
 *
 * BlockNote's external-HTML exporter never sees the inside of a table. A table
 * block's content is a `tableContent`, which `serializeBlocksExternalHTML`
 * turns into `tableRow` NODES; a row is not registered inline content, so the
 * exporter falls through to `DOMSerializer.serializeFragment`, and that one
 * call resolves the entire subtree — rows, cells, cell paragraphs and the
 * inline nodes inside them — through ProseMirror's `NodeSpec.toDOM`. The
 * exporter's `toExternalHTML` lookup is never reached below a table.
 *
 * `createInlineContentSpec` builds that `toDOM` (TipTap's `renderHTML`) from
 * `render`, the same function it gives `addNodeView`. So the editor's chip is
 * what a cell writes to the vault file: `[[Roadmap]]` came back as `Roadmap`
 * and `((mention:…))` as `[example.com](https://example.com/plain)`, with the
 * marker gone from disk for good (#1865).
 *
 * BlockNote's own STYLE specs already split these two concerns the right way —
 * `renderHTML` prefers `toExternalHTML`, `addMarkView` uses `render` — which is
 * exactly why a bold run in a table cell has never been damaged. This gives
 * inline content the same split: the node view keeps the rich chip, and
 * `renderHTML` emits the on-disk form.
 *
 * Applied to every Memry inline spec in `createMemryInlineContentSpecs`, so the
 * property is structural rather than a habit. It is a no-op for the main
 * process — `createServerInlineSpecs` already passes the serialization function
 * as `render` — and that redundancy is the point: main stays correct even if a
 * server spec is one day handed a richer render, and the renderer stops needing
 * a rich render to also be a serializer, which it cannot be.
 */

import {
  addInlineContentAttributes,
  nodeToCustomInlineContent,
  type CustomInlineContentConfig,
  type InlineContentSpec
} from '@blocknote/core'

/**
 * `render` and `toExternalHTML` are typed with `any` inline content by
 * BlockNote itself, so the cast is at the framework's own boundary rather than
 * over one of ours. `dom` is narrowed to `HTMLElement` because
 * `addInlineContentAttributes` writes attributes onto it; every Memry inline
 * spec returns a `<span>`, and one that returned a bare fragment would carry no
 * attributes to decorate anyway.
 */
type InlineSpecImplementation = {
  node: { extend: (config: object) => unknown }
  toExternalHTML?: (inlineContent: never, editor: never) => { dom: HTMLElement } | undefined
}

export function serializeThroughExternalHTML<T extends CustomInlineContentConfig>(
  spec: InlineContentSpec<T>
): InlineContentSpec<T> {
  const implementation = spec.implementation as unknown as InlineSpecImplementation
  const toExternalHTML = implementation.toExternalHTML
  // A spec with no `toExternalHTML` already serializes through `render`
  // everywhere, in a cell and out of it. Nothing to split.
  if (!toExternalHTML) return spec

  const node = implementation.node.extend({
    renderHTML(this: { options: { editor: never } }, { node }: { node: { attrs: never } }) {
      const editor = this.options.editor as unknown as {
        schema: { inlineContentSchema: never; styleSchema: never }
      }
      const inlineContent = nodeToCustomInlineContent(
        node as never,
        editor.schema.inlineContentSchema,
        editor.schema.styleSchema
      )

      return addInlineContentAttributes(
        toExternalHTML(inlineContent as never, this.options.editor) as { dom: HTMLElement },
        spec.config.type,
        node.attrs,
        spec.config.propSchema
      )
    }
  })

  return {
    ...spec,
    implementation: { ...spec.implementation, node }
  } as InlineContentSpec<T>
}
