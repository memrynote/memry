/* oxlint-disable typescript/no-explicit-any */

import { blockToNode, type Block, type BlockNoteEditor } from '@blocknote/core'
import { Fragment, Slice, type Node as ProseMirrorNode, type ResolvedPos } from '@tiptap/pm/model'
import { NodeSelection, Selection, type Transaction } from '@tiptap/pm/state'
import { createLogger } from '@/lib/logger'
import { parseMarkdownPreservingBlanks } from './markdown-utils'
import { normalizeNoteBlocks } from './normalize-note-blocks'

const log = createLogger('PasteMarkdown')

type Editor = BlockNoteEditor<any, any, any>

/**
 * A paste whose markdown is still being parsed, aimed at the selection it was
 * made in. The target is mapped through every change to the document, so the
 * paste lands where it was made, wherever the caret is by the time it lands.
 */
interface PendingPaste {
  target: Selection
}

/**
 * One editor's pastes, landing in the order they were made. Parsing is
 * asynchronous: the note parser shared with main is, and a pasted `![[image]]`
 * is resolved against the vault by main. Without the queue a callout pasted
 * before a sentence could land after it, because a callout takes longer to
 * parse.
 */
interface PasteQueue {
  last: Promise<void>
  pending: PendingPaste[]
}

const queues = new WeakMap<Editor, PasteQueue>()

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
  editor: Editor,
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
  if (markdown !== null) queuePaste(editor, markdown, resolveNotePath)
  return handled
}

function queuePaste(
  editor: Editor,
  markdown: string,
  resolveNotePath?: () => Promise<string | undefined>
): void {
  const queue = queueFor(editor)
  const paste: PendingPaste = { target: editor.prosemirrorState.selection }
  queue.pending.push(paste)
  queue.last = queue.last.then(() => landPaste(editor, queue, paste, markdown, resolveNotePath))
}

async function landPaste(
  editor: Editor,
  queue: PasteQueue,
  paste: PendingPaste,
  markdown: string,
  resolveNotePath?: () => Promise<string | undefined>
): Promise<void> {
  try {
    const blocks = await parseNoteMarkdown(editor, markdown, resolveNotePath)
    // Opening another note remounts the editor, so a note switch lands here too.
    if (editor._tiptapEditor.isDestroyed) {
      log.warn('Dropped a markdown paste: its editor closed before the paste was parsed', {
        length: markdown.length
      })
      return
    }
    if (blocks.length === 0) return
    // A paste made before this one landed, at the same caret, follows it
    // there, as it would have if this one had landed at once.
    const followers = queue.pending.filter(
      (other) => other !== paste && other.target.eq(paste.target)
    )
    pasteBlocks(editor, blocks, paste.target)
    for (const follower of followers) follower.target = editor.prosemirrorState.selection
  } catch (error) {
    log.error('Pasting markdown failed', { length: markdown.length, error })
  } finally {
    queue.pending.splice(queue.pending.indexOf(paste), 1)
  }
}

function queueFor(editor: Editor): PasteQueue {
  const existing = queues.get(editor)
  if (existing) return existing
  const queue: PasteQueue = { last: Promise.resolve(), pending: [] }
  editor._tiptapEditor.on('transaction', ({ transaction, appendedTransactions }) => {
    for (const tr of [transaction, ...appendedTransactions]) {
      if (!tr.docChanged) continue
      for (const paste of queue.pending) paste.target = paste.target.map(tr.doc, tr.mapping)
    }
  })
  queues.set(editor, queue)
  return queue
}

async function parseNoteMarkdown(
  editor: Editor,
  markdown: string,
  resolveNotePath?: () => Promise<string | undefined>
): Promise<Block<any, any, any>[]> {
  try {
    const notePath = await resolveNotePath?.()
    return normalizeNoteBlocks(
      await parseMarkdownPreservingBlanks(editor, markdown, notePath),
      markdown
    )
  } catch (error) {
    log.error('Parsing pasted markdown as note blocks failed, using BlockNote parser', error)
    return editor.tryParseMarkdownToBlocks(markdown)
  }
}

/**
 * Pastes `blocks` at `target` as one paste transaction, so one undo step
 * takes it back.
 *
 * A first or last block that is plain text opens into the text at the caret,
 * as BlockNote's markdown paste does: a pasted sentence lands inline, and a
 * first paragraph joins the text before the caret. A callout, math block or
 * table on the first edge is a block of its own, and ProseMirror would nest it
 * under the paragraph holding the caret, because a block container is
 * `defining`. That paragraph is split at the caret instead, and the blocks go
 * between its halves, or before or after it when the caret is at an end.
 *
 * A selected block is replaced by the pasted blocks. Its children, and those of
 * a block whose end the paste replaces, move to the last pasted block, as they
 * do when BlockNote's own paste ends in text.
 */
function pasteBlocks(editor: Editor, blocks: Block<any, any, any>[], target: Selection): void {
  const view = editor.prosemirrorView
  const { schema } = view.state
  const tr = view.state.tr.setSelection(target)
  const containers = blocksFor(tr.selection.$from, blocks).map((block) =>
    blockToNode(block, schema)
  )
  const selected = selectedBlock(tr.selection)
  if (selected) {
    const content = Fragment.from(withChildren(containers, childGroup(selected.node)))
    tr.replaceWith(selected.pos, selected.pos + selected.node.nodeSize, content)
    tr.setSelection(Selection.near(tr.doc.resolve(selected.pos + content.size), -1))
  } else {
    if (!tr.selection.empty) tr.deleteSelection()
    const { $from } = tr.selection
    const openStart = openDepth(containers[0], 'start')
    if (openStart > 1 || !$from.parent.isTextblock || $from.parent.content.size === 0) {
      const openEnd = openDepth(containers.at(-1), 'end')
      // A closed last block leaves the rest of the caret's block behind as a
      // block of its own; with no text left, it would be an empty block
      // holding the children.
      const atEnd = $from.parent.isTextblock && $from.parentOffset === $from.parent.content.size
      const children = openEnd === 1 && atEnd ? childGroup($from.node($from.depth - 1)) : null
      if (children) tr.delete($from.after(), $from.after() + children.nodeSize)
      const group = schema.nodes.blockGroup.create(null, withChildren(containers, children))
      tr.replaceSelection(new Slice(Fragment.from(group), openStart, openEnd))
    } else {
      const pos = blockBoundaryAtCaret(tr)
      const fragment = Fragment.from(containers)
      tr.insert(pos, fragment)
      tr.setSelection(Selection.near(tr.doc.resolve(pos + fragment.size), -1))
    }
  }
  view.dispatch(tr.scrollIntoView().setMeta('paste', true).setMeta('uiEvent', 'paste'))
}

/**
 * A column cannot hold a column list, so pasted columns give their blocks, in
 * reading order, to the column holding the caret.
 */
function blocksFor($pos: ResolvedPos, blocks: Block<any, any, any>[]): Block<any, any, any>[] {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === 'column') {
      return blocks.flatMap((block) =>
        block.type === 'columnList'
          ? block.children.flatMap((column: Block<any, any, any>) => column.children)
          : [block]
      )
    }
  }
  return blocks
}

/** The block container a node selection holds, whole or by its content. */
function selectedBlock(selection: Selection): { pos: number; node: ProseMirrorNode } | null {
  if (!(selection instanceof NodeSelection)) return null
  if (selection.node.type.name === 'blockContainer') {
    return { pos: selection.from, node: selection.node }
  }
  const { $from } = selection
  return $from.parent.type.name === 'blockContainer'
    ? { pos: $from.before(), node: $from.parent }
    : null
}

/** A block container's nested blocks, if it has any. */
function childGroup(container: ProseMirrorNode): ProseMirrorNode | null {
  return container.childCount > 1 ? container.lastChild : null
}

/** `containers`, with `children` nested under the last one after its own. */
function withChildren(
  containers: ProseMirrorNode[],
  children: ProseMirrorNode | null
): ProseMirrorNode[] {
  const last = containers.at(-1)
  if (!children) return containers
  // A column list nests no blocks, so they follow it instead.
  if (last?.type.name !== 'blockContainer') return [...containers, ...children.content.content]
  const own = childGroup(last)
  const group = own ? own.copy(own.content.append(children.content)) : children
  return [...containers.slice(0, -1), last.copy(Fragment.from([last.child(0), group]))]
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
