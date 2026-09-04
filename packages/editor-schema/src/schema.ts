import {
  type BlockSpecs,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { createMemryInlineContentSpecs, type MemryInlineSpecs } from './inline'
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
}) {
  const blockSpecs = {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(impl.codeBlock ?? CODE_BLOCK_DEFAULTS),
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
