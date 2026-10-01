import { parseYoutubeEmbedLine, serializeYoutubeEmbed } from './markdown'

interface BlockLike {
  id?: string
  type: string
  props?: Record<string, unknown>
  children?: unknown[]
}

/**
 * Turn top-level image blocks that point at a YouTube video into `youtubeEmbed`.
 *
 * `parseYoutubeEmbedLine` only sees a line that is nothing but the marker. A
 * YouTube image line that is part of a paragraph never reaches it, for example
 * one directly under a line of text, as OneNote exports through Obsidian's
 * importer write it:
 *
 *     A Pitada do Pai
 *      ![Embedded YouTube video](https://www.youtube.com/embed/…)
 *
 * The parser lifts that image into its own `image` block. A web page is not an
 * image, so it rendered broken. Older builds also stored such blocks in shared
 * Y.Docs, where a re-parse never reaches them, so the editor runs this on open
 * as well as after every parse.
 *
 * Byte-neutral: the image wrote `![name](url)` on its own line, and the embed
 * keeps `name` as its alt, so it writes the same line. Only an image with no
 * caption and no children qualifies, because only that one is written as that
 * single line. Top level only, because a nested embed is written with nesting
 * markers where a nested image is an indented list line.
 */
export function normalizeYoutubeImages<T extends BlockLike>(
  blocks: T[]
): { blocks: T[]; didChange: boolean } {
  let didChange = false
  const next = blocks.map((block) => {
    if (block.type !== 'image' || block.children?.length) return block
    const { url, name, caption } = (block.props ?? {}) as {
      url?: string
      name?: string
      caption?: string
    }
    if (!url || caption) return block
    const embed = parseYoutubeEmbedLine(serializeYoutubeEmbed(url, name ?? ''))
    if (!embed) return block
    didChange = true
    // SAFETY: `youtubeEmbed`'s declared props, all strings. The id is kept so
    // y-prosemirror replaces the block in place.
    return { id: block.id, type: 'youtubeEmbed', props: embed, children: [] } as unknown as T
  })
  return { blocks: didChange ? next : blocks, didChange }
}
