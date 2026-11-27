/* oxlint-disable typescript/no-explicit-any */

import { blockToNode, type Block, type BlockNoteEditor } from '@blocknote/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Selection, type Transaction } from '@tiptap/pm/state'
import { createLogger } from '@/lib/logger'
import { parseMarkdownPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const log = createLogger('PasteMarkdown')

/**
 * Runs BlockNote's paste with Memry's markdown parser in place of BlockNote's.
 *
 * BlockNote decides which clipboard flavour a paste reads: `blocknote/html`
 * from another Memry editor, files, a code block's literal text, a web page's
 * HTML, or `text/plain` read as markdown when nothing richer is there or when
 * it looks like markdown. That choice stays BlockNote's. What changes is the
 * markdown parse: BlockNote's own parser builds a quote reading `[!note]`,
 * paragraphs reading `$$`, and a plain image for a YouTube line, where the
 * note file holding the same bytes opens as a callout, a math block and an
 * embed. Pasted markdown goes through the parser the editor loads notes with
 * instead, so it builds the same blocks the note would after a save and reload.
 *
 * The flavour choice is captured by catching BlockNote's `pasteMarkdown` call
 * for the length of the default handler, since BlockNote does not export the
 * markdown sniffing it bases the choice on.
 */
export function pasteWithNoteMarkdown(
  editor: BlockNoteEditor<any, any, any>,
  defaultPaste: () => boolean | undefined,
  resolveNotePath?: () => Promise<string | undefined>
): boolean | undefined {
  let markdown: string | null = null
  editor.pasteMarkdown = (text: string) => {
    markdown = text
  }
  let handled: boolean | undefined
  try {
    handled = defaultPaste()
  } finally {
    // Uncovers BlockNote's own method on the prototype again.
    Reflect.deleteProperty(editor, 'pasteMarkdown')
  }
  if (markdown !== null) void insertMarkdown(editor, markdown, resolveNotePath)
  return handled
}

async function insertMarkdown(
  editor: BlockNoteEditor<any, any, any>,
  markdown: string,
  resolveNotePath?: () => Promise<string | undefined>
): Promise<void> {
  try {
    const notePath = await resolveNotePath?.()
    const blocks = normalizeNoteBlocks(
      await parseMarkdownPreservingBlanks(editor, markdown, notePath),
      markdown
    )
    pasteBlocks(editor, blocks)
  } catch (error) {
    log.error('Pasting markdown as note blocks failed, pasting it with BlockNote parser', error)
    editor.pasteMarkdown(markdown)
  }
}

/**
 * Pastes `blocks` at the caret as one paste transaction, so one undo step
 * takes it back.
 *
 * A first or last block that is plain text opens into the text at the caret,
 * as BlockNote's markdown paste does: a pasted sentence lands inline, and a
 * first paragraph joins the text before the caret. A callout, math block or
 * table on the first edge is a block of its own, and ProseMirror would nest it
 * under the paragraph holding the caret, because a block container is
 * `defining`. That paragraph is split at the caret instead, and the blocks go
 * between its halves, or before or after it when the caret is at an end.
 */
function pasteBlocks(editor: BlockNoteEditor<any, any, any>, blocks: Block<any, any, any>[]): void {
  const view = editor.prosemirrorView
  if (!view || blocks.length === 0) return
  const { schema } = view.state
  const containers = blocks.map((block) => blockToNode(block, schema))
  const tr = view.state.tr
  if (!tr.selection.empty) tr.deleteSelection()
  const { $from } = tr.selection
  const openStart = openDepth(containers[0], 'start')
  if (openStart > 1 || !$from.parent.isTextblock || $from.parent.content.size === 0) {
    const group = schema.nodes.blockGroup.create(null, containers)
    tr.replaceSelection(
      new Slice(Fragment.from(group), openStart, openDepth(containers.at(-1), 'end'))
    )
  } else {
    const pos = blockBoundaryAtCaret(tr)
    const fragment = Fragment.from(containers)
    tr.insert(pos, fragment)
    tr.setSelection(Selection.near(tr.doc.resolve(pos + fragment.size), -1))
  }
  view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
}

/** Block group, then block container and text block when the edge block is plain text. */
function openDepth(container: ProseMirrorNode | undefined, side: 'start' | 'end'): number {
  const content = container?.firstChild
  const hasChildren = (container?.childCount ?? 0) > 1
  const textEdge = content?.isTextblock && !content.type.spec.isolating
  return textEdge && (side === 'start' || !hasChildren) ? 3 : 1
}

/**
 * The position between two blocks nearest the caret in a non-empty text
 * block: before its block, after it, or between the halves of a split.
 */
function blockBoundaryAtCaret(tr: Transaction): number {
  const { $from } = tr.selection
  const container = $from.depth - 1
  if ($from.parentOffset === 0) return $from.before(container)
  if ($from.parentOffset === $from.parent.content.size) return $from.after(container)
  tr.split($from.pos, 2)
  return $from.pos + 2
}
