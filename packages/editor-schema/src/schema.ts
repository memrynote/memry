import {
  type BlockSpecs,
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  createCodeBlockSpec
} from '@blocknote/core'
import { codeBlockOptions } from '@blocknote/code-block'
import { createMemryInlineContentSpecs, type MemryInlineSpecs } from './inline'

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
 */
export function createMemrySchema<Blocks extends BlockSpecs>(impl: {
  blocks: Blocks
  inline: MemryInlineSpecs
}) {
  return BlockNoteSchema.create({
    blockSpecs: {
      ...defaultBlockSpecs,
      codeBlock: createCodeBlockSpec(codeBlockOptions),
      ...impl.blocks
    },
    inlineContentSpecs: {
      ...defaultInlineContentSpecs,
      ...createMemryInlineContentSpecs(impl.inline)
    }
  })
}
