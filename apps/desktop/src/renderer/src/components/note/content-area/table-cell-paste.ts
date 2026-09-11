/* eslint-disable @typescript-eslint/no-explicit-any */

import type { BlockNoteEditor } from '@blocknote/core'
import { insertUrlAsLink, readBareUrl } from './paste-url-link'

/**
 * BlockNote reads `text/plain` off the clipboard as markdown. Everywhere else
 * that is what people want, but a table cell holds inline content only: text
 * that merely *looks* like a markdown table (`| a | b |`) is parsed into a real
 * table, and prosemirror-tables then splices that table's cells over the row
 * the cursor sits in — the cell's own text is gone and columns appear that
 * nobody asked for. The user has to retype the row.
 *
 * So inside a cell, plain text stays plain text. Richer clipboard flavours are
 * untouched: `blocknote/html` (a cell or cell range copied inside the app) and
 * `text/html` are picked ahead of `text/plain` by the default handler and both
 * still paste as structure.
 *
 * See issue #1641.
 */

// The two node names BlockNote gives a table cell — a header cell is its own
// node type, not a `tableCell` with a flag.
const TABLE_CELL_NODES = new Set(['tableCell', 'tableHeader'])

export function isSelectionInTableCell(editor: BlockNoteEditor<any, any, any>): boolean {
  try {
    return editor.transact((tr) => {
      const { $from } = tr.selection
      for (let depth = $from.depth; depth > 0; depth--) {
        if (TABLE_CELL_NODES.has($from.node(depth).type.name)) return true
      }
      return false
    })
  } catch {
    // No editor view yet (or a selection shape without a resolved position) —
    // let the default handler decide.
    return false
  }
}

interface PasteContext {
  editor: BlockNoteEditor<any, any, any>
  event: ClipboardEvent
  defaultPasteHandler: (options?: {
    prioritizeMarkdownOverHTML?: boolean
    plainTextAsMarkdown?: boolean
  }) => boolean | undefined
}

export function handleEditorPaste({
  editor,
  event,
  defaultPasteHandler
}: PasteContext): boolean | undefined {
  // A clipboard holding nothing but a URL becomes an inline link, wherever the
  // cursor is. The default handler would read it as markdown and replace the
  // block, dropping a list item's bullet or number. See `paste-url-link.ts`.
  // A clipboard carrying files is an attachment paste even when its text
  // flavour happens to read as a URL — leave those to the default handler.
  const clipboard = event?.clipboardData
  const url = clipboard?.files?.length ? null : readBareUrl(clipboard?.getData('text/plain'))
  if (url && insertUrlAsLink(editor, url)) {
    event.preventDefault()
    return true
  }

  if (!isSelectionInTableCell(editor)) return defaultPasteHandler()

  // Both flags gate a markdown reading of `text/plain`: the first sniffs the
  // text for markdown syntax, the second is the fallback when `text/plain` is
  // the only flavour on the clipboard. Turning off just one still leaves the
  // other reading a pasted `| a | b |` as a table.
  return defaultPasteHandler({
    prioritizeMarkdownOverHTML: false,
    plainTextAsMarkdown: false
  })
}
