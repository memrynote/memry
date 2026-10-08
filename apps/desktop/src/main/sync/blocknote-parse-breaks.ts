import { AsyncLocalStorage } from 'node:async_hooks'
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
  return parseMarkdownToBlocksRepaired<Block>(editor, markdown, {
    htmlComments: parsesHtmlComments()
  })
}

// A scope rather than a parameter: every parse below a seed reaches this
// binding through a dozen helpers, and a module flag would leak into a seed
// running concurrently, which would then drop the user's comments.
const htmlCommentsDropped = new AsyncLocalStorage<true>()

/**
 * Runs `parse` with every HTML comment dropped, as builds before #2741 parsed,
 * so a source can be read the way the document that recorded it was (BBF-29).
 */
export function parseDroppingHtmlComments<T>(parse: () => Promise<T>): Promise<T> {
  return htmlCommentsDropped.run(true, parse)
}

export function parsesHtmlComments(): boolean {
  return htmlCommentsDropped.getStore() !== true
}
