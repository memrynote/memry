/**
 * Oracle ops of the block serializer (stage 5 of #3522): `serializeBlocks` of
 * `blocknote-converter.ts` (the function is private there, so its five steps
 * are repeated here in the same order), alone on hand-written blocks and after
 * `prepareFragmentSeed` on markdown.
 */
import type { PartialBlock } from '@blocknote/core'
import { setCalloutTypeDefinitions } from '@memry/editor-schema/blocks'
import { writeHtmlCommentTokens } from '@memry/editor-schema/inline'
import { normalizeSerializedMarkdown } from '@memry/shared/empty-lines'
import { extractInlineColorRuns, restoreInlineColorTokens } from '@memry/shared/inline-colors'
import { withPlainCheckboxMarkers } from '@memry/shared/plain-checkbox'

import { prepareFragmentSeed } from '../../src/main/sync/blocknote-converter'
import { getEditor } from './bn-oracle'
import type { MemryParseInput } from './memry-oracle'

export async function serializeBlocks(blocks: PartialBlock[]): Promise<string> {
  const editor = getEditor()
  const { blocks: wrapped, replacements } = extractInlineColorRuns(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the same cast blocknote-converter.ts makes: BlockNote's generics do not model the memry blocks
    withPlainCheckboxMarkers(blocks as never[])
  )
  const md = normalizeSerializedMarkdown(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- as above
    await writeHtmlCommentTokens(wrapped as PartialBlock[], (b) => editor.blocksToMarkdownLossy(b))
  )
  return restoreInlineColorTokens(md, replacements)
}

/** `prepareFragmentSeed`, then `serializeBlocks` of the blocks it produced. */
export async function serializeSeed(input: MemryParseInput): Promise<unknown> {
  setCalloutTypeDefinitions(input.calloutTypes ?? [])
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the job's `writing` is a WritingFrontmatter written by the case list
  const writing = input.writing as Parameters<typeof prepareFragmentSeed>[2]
  const seed = await prepareFragmentSeed(input.markdown, input.notePath, writing)
  try {
    if (!seed) return { markdown: null }
    return { markdown: await serializeBlocks(seed.blocks) }
  } finally {
    setCalloutTypeDefinitions([])
  }
}
