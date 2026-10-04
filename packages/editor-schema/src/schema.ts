import {
  type BlockSpecs,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { createMemryInlineContentSpecs, type MemryInlineSpecs } from './inline'
import { withImageWidthInAlt } from './blocks/image-width'
import { withPlainCheckbox } from './blocks/plain-checkbox'
import { createColumnBlockSpec, createColumnListBlockSpec } from './blocks/column-specs'
import { assertSpecKeysMatchNodeTypes, type SpecKeysMatchNodeTypes } from './spec-keys'

/**
 * `language.default`, and the reason this package no longer imports
 * `@blocknote/code-block` itself.
 *
 * The highlighter's options are three fields, and only `defaultLanguage`
 * reaches the spec's `propSchema` — `createCodeBlockSpec({ defaultLanguage:
 * 'javascript' })` builds a config byte-identical to the full
 * `codeBlockOptions`. The other two carry shiki, which is 3.4 MB of the mobile
 * WebView bundle's 4.4 MB and blocked its JS thread for 3.2 s on every note
 * open (#2032, #2044).
 *
 * So the bytes are the caller's choice and the PROP SCHEMA is not. A surface
 * that skips the highlighter still declares `language` with the same default,
 * because a differing default flips the language on a code block written by
 * the other surface.
 */
const CODE_BLOCK_DEFAULTS = { defaultLanguage: 'javascript' } as const

type CodeBlockOptions = NonNullable<Parameters<typeof createCodeBlockSpec>[0]>
type CodeBlockSpec = ReturnType<typeof createCodeBlockSpec>

/**
 * A code block whose `language` the picker does not list renders as Plain Text
 * instead of taking the whole editor down.
 *
 * BlockNote 0.54's language picker throws `Language <x> is not supported` for
 * any value missing from `supportedLanguages`, from inside the node view, so
 * the error boundary replaces the entire note with "Editor Error". Memry
 * stores whatever a fence was tagged with, and an untagged fence as `''`
 * (#1909), so one bare ``` fence (an Obsidian Kanban settings block) or one
 * tag the picker lacks was enough to make a note unopenable.
 *
 * Only what the picker is handed changes. `block.props.language` keeps its
 * value, so the fence is written back exactly as it was read; the user just
 * sees Plain Text selected until they pick something else.
 */
function renderUnlistedLanguageAsPlainText(
  spec: CodeBlockSpec,
  options: CodeBlockOptions
): CodeBlockSpec {
  const supported = options.supportedLanguages
  if (!supported) return spec
  const fallback = 'text' in supported ? 'text' : Object.keys(supported)[0]
  if (fallback === undefined) return spec

  const render = spec.implementation.render
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(block, editor) {
        if (block.props.language in supported) return render.call(this, block, editor)
        const shown = { ...block, props: { ...block.props, language: fallback } }
        return render.call(this, shown, editor)
      }
    }
  }
}

type CodeBlockRender = CodeBlockSpec['implementation']['render']

/**
 * A code block tagged with one of `views`' languages is drawn by that view
 * instead of as code. Presentation only: the node, its props and its fence are
 * the code block's, so a surface without the view (main, mobile, an older
 * build) still holds the block as code and writes the same bytes back. That is
 * the whole reason a feature like the `memry-view` block (#2488) rides on a
 * fence instead of adding a node type y-prosemirror would delete elsewhere.
 */
function renderCodeLanguageViews(
  spec: CodeBlockSpec,
  views: Readonly<Record<string, CodeBlockRender>> | undefined
): CodeBlockSpec {
  if (!views || Object.keys(views).length === 0) return spec
  const render = spec.implementation.render
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(block, editor) {
        const view = Object.hasOwn(views, block.props.language)
          ? views[block.props.language]
          : undefined
        return (view ?? render).call(this, block, editor)
      }
    }
  }
}

/**
 * The one place a Memry BlockNote schema is built.
 *
 * Renderer and main process both call this, so neither can carry a node type
 * the other lacks. That symmetry is not cosmetic: the main process converts the
 * shared Y.Doc through y-prosemirror, whose response to an unknown node name is
 * to DELETE the element from the doc — a missing spec replicates as data loss,
 * not as a rendering gap.
 *
 * Callers pass presentation only. `blocks` is generic so the renderer keeps the
 * precise schema type its typed block helpers depend on.
 *
 * `codeBlock` is presentation too, and is passed the same way: a surface that
 * wants syntax highlighting hands in `codeBlockOptions` from
 * `@blocknote/code-block`, and one that cannot afford the bytes passes nothing
 * and still gets the same node with the same props (see CODE_BLOCK_DEFAULTS).
 *
 * It is also the last place both processes' FULL spec maps exist — the
 * renderer's React blocks reach no factory in this package — so it is where
 * `key ≡ config.type` is checked for blocks and inline content alike (#1455).
 * The factories check their own maps as well, to name the one that is wrong;
 * this is the check nothing can route around.
 */
export function createMemrySchema<Blocks extends BlockSpecs>(impl: {
  blocks: Blocks & SpecKeysMatchNodeTypes<Blocks>
  inline: MemryInlineSpecs
  codeBlock?: Parameters<typeof createCodeBlockSpec>[0]
  /** Code-block renders keyed by fence language; see `renderCodeLanguageViews`. */
  codeBlockViews?: Readonly<Record<string, CodeBlockRender>>
}) {
  const blockSpecs = {
    ...defaultBlockSpecs,
    codeBlock: renderCodeLanguageViews(
      renderUnlistedLanguageAsPlainText(
        createCodeBlockSpec(impl.codeBlock ?? CODE_BLOCK_DEFAULTS),
        impl.codeBlock ?? CODE_BLOCK_DEFAULTS
      ),
      impl.codeBlockViews
    ),
    // BlockNote's own image, with its resized width written to the vault file
    // instead of dropped. Here rather than per surface: a surface that dropped
    // the width would erase it from the file on its next write-back.
    image: withImageWidthInAlt(defaultBlockSpecs.image),
    // The checkbox the user keeps as a checkbox. Here for the same reason as
    // the image: a surface without the prop writes the flag away.
    checkListItem: withPlainCheckbox(defaultBlockSpecs.checkListItem),
    // Side-by-side columns, here so no surface can lack them (y-prosemirror
    // deletes what it cannot build). The desktop renderer overrides `column`
    // with `@blocknote/xl-multi-column`'s, which adds resize and
    // drag-to-column on the same node; see blocks/column-specs.ts.
    column: createColumnBlockSpec(),
    columnList: createColumnListBlockSpec(),
    ...impl.blocks
  }
  const memryInlineSpecs = createMemryInlineContentSpecs(impl.inline)
  const inlineContentSpecs = { ...defaultInlineContentSpecs, ...memryInlineSpecs }

  // Once, at construction. Both processes call this at module scope, so a
  // mis-keyed spec is a failed schema build — not a note that quietly loses a
  // wiki link on its next write-back.
  //
  // Deliberately over what WE supply, not over the merged maps. Memry cannot
  // mis-key BlockNote's own defaults, so asserting them buys nothing — but it
  // would turn a future BlockNote minor that ships an aliased default into an
  // app that does not launch, in both processes, at module scope. Same
  // protection, none of that exposure.
  assertSpecKeysMatchNodeTypes('blockSpecs', impl.blocks)
  assertSpecKeysMatchNodeTypes('inlineContentSpecs', memryInlineSpecs)

  return BlockNoteSchema.create({ blockSpecs, inlineContentSpecs })
}
