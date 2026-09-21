import type { ServerBlockNoteEditor } from '@blocknote/server-util'
import type { Block } from '@blocknote/core'
import { parseMarkdownToBlocksRepaired } from '@memry/editor-schema/parse-markdown'

/**
 * Markdown to blocks on the main process.
 *
 * The repairs themselves live in `@memry/editor-schema` because the renderer
 * parses the same markdown and has to produce the same document; see that
 * module for what BlockNote 0.51+ breaks and how each part is carried across
 * the parse. This is the main-side binding, typed to the server editor.
 */
export async function parseMarkdownToBlocks(
  editor: ServerBlockNoteEditor,
  markdown: string
): Promise<Block[]> {
  return parseMarkdownToBlocksRepaired<Block>(editor, markdown)
}
