import { type Block } from '@blocknote/core'
import { type BlockColors } from '@memry/shared/block-colors'
import { type MarkedBlock } from '@memry/shared/block-markers'
import { type FileBlockProps } from './file-block-markers'

/*
 * The audited casts of this surface. BlockNote's `Block` is a union keyed on the
 * schema's block types, with `props` keyed per type, so no hand-written literal
 * is assignable without naming the whole schema, and the shared markdown helpers
 * take their own structural shapes. Each call site states the shape it relies
 * on; the round-trip tests against the main-process twin are what check it.
 */

/** A literal whose fields are what its named `type` declares in the schema. */
export function schemaBlock(literal: unknown): Block {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- schema-typed literal; Block cannot be built without naming the whole schema
  return literal as Block
}

export function schemaBlocks(blocks: unknown): Block[] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- parser output is Block[] by the editor schema; the shared helpers type it structurally
  return blocks as Block[]
}

/** The `{ type, props }` subset the sidecar patches read and write; every `Block` has both. */
export function markedBlock(block: unknown): MarkedBlock {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MarkedBlock is a structural subset of every Block
  return block as MarkedBlock
}

interface BlockPropShapes {
  toggleListItem: BlockColors & { open?: boolean }
  youtubeEmbed: { videoUrl: string; alt?: string }
  bookmark: { url: string }
  callout: { type: string; fold?: string }
  mathBlock: { latex?: string }
  codeBlock: { language?: string }
  file: FileBlockProps
}

/** A block's props as its named type's spec declares them. */
export function propsFor<K extends keyof BlockPropShapes>(
  block: Block,
  _type: K
): BlockPropShapes[K] {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the caller names the block type, whose props are what the spec declares
  return block.props as BlockPropShapes[K]
}
