import {
  type BlockSpecs,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createMemryInlineContentSpecs, type MemryInlineSpecs } from './inline'
import { assertSpecKeysMatchNodeTypes, type SpecKeysMatchNodeTypes } from './spec-keys'

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
 * It is also the last place both processes' FULL spec maps exist — the
 * renderer's React blocks reach no factory in this package — so it is where
 * `key ≡ config.type` is checked for blocks and inline content alike (#1455).
 * The factories check their own maps as well, to name the one that is wrong;
 * this is the check nothing can route around.
 */
export function createMemrySchema<Blocks extends BlockSpecs>(impl: {
  blocks: Blocks & SpecKeysMatchNodeTypes<Blocks>
  inline: MemryInlineSpecs
}) {
  const blockSpecs = {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
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
