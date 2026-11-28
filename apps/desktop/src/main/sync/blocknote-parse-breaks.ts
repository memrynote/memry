import { AsyncLocalStorage } from 'node:async_hooks'
import type { ServerBlockNoteEditor } from '@blocknote/server-util'
import type { Block } from '@blocknote/core'
import { parseMarkdownToBlocksRepaired } from '@memry/editor-schema/parse-markdown'
import type { LegacyReading } from '@memry/shared/markdown-code'

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
    htmlComments: parsesHtmlComments(),
    losslessBlocks: readsLosslessBlocks(),
    literalHtml: readsLiteralHtml()
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

const legacyBlocks = new AsyncLocalStorage<true>()

/**
 * Runs `parse` with blocks read as builds before lossless blocks did: a table
 * row split on a code span's pipe and cut to its header's width, a quote or
 * callout holding a table or a heading read as one flat quote, and a list
 * item's images dropped. A source
 * those builds recorded is read that way, so the cells and blocks their
 * document never got do not read as ones the user deleted.
 */
export function parseWithLegacyBlocks<T>(parse: () => Promise<T>): Promise<T> {
  return legacyBlocks.run(true, parse)
}

export function readsLosslessBlocks(): boolean {
  return legacyBlocks.getStore() !== true
}

const legacyHtml = new AsyncLocalStorage<true>()

/**
 * Runs `parse` with raw HTML read as builds before it stayed text did: the
 * tags the editor has no node for dropped, a code span and a `</span>` read the
 * way those builds did. A source one of them recorded is read that way, so the
 * `<kbd>`, `<sup>` and `<div>` its document never held do not read as text the
 * user deleted, and the file keeps them.
 */
export function parseWithLegacyHtml<T>(parse: () => Promise<T>): Promise<T> {
  return legacyHtml.run(true, parse)
}

export function readsLiteralHtml(): boolean {
  return legacyHtml.getStore() !== true
}

/** How the scopes above read a comment's code spans, for `maskHtmlComments`. */
export function legacyReading(): LegacyReading {
  return { tables: !readsLosslessBlocks(), html: !readsLiteralHtml() }
}
