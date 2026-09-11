/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BlockNoteEditor } from '@blocknote/core'

/**
 * A clipboard payload that is nothing but a single `http(s)` URL.
 *
 * This is the same predicate the paste-link menu keys off, so the menu and the
 * editor's paste handler always agree on what counts as a "pasted URL".
 */
const BARE_URL_REGEX = /^https?:\/\/\S+$/

/** The clipboard text as a bare URL, or `null` when it is anything else. */
export function readBareUrl(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  if (!trimmed || !BARE_URL_REGEX.test(trimmed)) return null
  return trimmed
}

/**
 * BlockNote reads `text/plain` as markdown, so a bare URL comes back as a
 * *paragraph block* and pasting it replaces the block the cursor sits in — a
 * bulleted list item loses its bullet, a numbered item its number (issue
 * #2081). Inserting the URL as inline content instead never touches the block:
 * list items, nested list items and table cells keep their type and props, and
 * the text before and after the cursor is preserved.
 *
 * The result is an ordinary inline `link`, not an atomic chip, so the caret can
 * sit on either side of it and it can be selected, copied, edited and moved
 * like any other text (issue #2080). It is also exactly the shape the Mention,
 * Bookmark and Embed branches already look for (`type === 'link'` with a
 * matching `href`), so those paths are unaffected.
 */
export function insertUrlAsLink(editor: BlockNoteEditor<any, any, any>, url: string): boolean {
  try {
    editor.insertInlineContent([{ type: 'link', href: url, content: url }])
    return true
  } catch {
    // No editor view yet, or a selection that cannot hold inline content — let
    // the default paste handler deal with it.
    return false
  }
}
