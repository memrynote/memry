import type { Block } from '@blocknote/core'
import { parseYoutubeEmbedLine, serializeYoutubeEmbed } from '@memry/editor-schema/blocks'

/**
 * Turn top-level image blocks that point at a YouTube video into `youtubeEmbed`.
 *
 * Before `parseYoutubeEmbedLine` accepted any alt text, a line such as
 * `![Embedded YouTube video](https://www.youtube.com/watch?v=…)` (Obsidian's
 * embed form) was parsed as an image block. A web page is not an image, so it
 * rendered broken, and that block is now stored in the note's shared Y.Doc,
 * where a better parser never sees it again.
 *
 * Byte-neutral: the image wrote `![name](url)`, and the embed keeps `name` as
 * its alt, so it writes the same line. Only an image with no caption and no
 * children qualifies, because only that one is written as that single line.
 * Top level only, because a nested embed is written with nesting markers where
 * a nested image is an indented list line.
 */
export function normalizeYoutubeImages(blocks: Block[]): { blocks: Block[]; didChange: boolean } {
  let didChange = false
  const next = blocks.map((block) => {
    if ((block.type as string) !== 'image' || block.children?.length) return block
    const props = block.props as { url?: string; name?: string; caption?: string }
    if (!props.url || props.caption) return block
    const embed = parseYoutubeEmbedLine(serializeYoutubeEmbed(props.url, props.name ?? ''))
    if (!embed) return block
    didChange = true
    // SAFETY: `youtubeEmbed`'s declared props, all strings; the id is kept so
    // y-prosemirror replaces the block in place.
    return { id: block.id, type: 'youtubeEmbed', props: embed, children: [] } as unknown as Block
  })
  return { blocks: didChange ? next : blocks, didChange }
}
