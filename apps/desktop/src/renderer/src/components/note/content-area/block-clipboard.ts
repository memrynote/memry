/**
 * Copy blocks to the clipboard from the block menu.
 *
 * Three flavours go on the clipboard, the same set BlockNote's own Cmd+C
 * writes:
 * - `blocknote/html`: ProseMirror's clipboard serialization of the block
 *   nodes. Pasting back into a Memry editor reads this first, so the blocks
 *   come back as they were: colours, toggles, callouts, task blocks.
 * - `text/html`: BlockNote's external HTML, for rich paste into other apps.
 * - `text/plain`: the blocks as Memry writes them to the note file.
 *
 * `blocknote/html` matters for the paste back. Without it BlockNote's paste
 * handler sniffs `text/plain`, finds markdown and parses that instead of the
 * HTML, so a coloured run or a callout would come back as plain text.
 *
 * @module note/content-area/block-clipboard
 */

/* eslint-disable @typescript-eslint/no-explicit-any -- Memry's editors carry
   different block schemas; the menu types them as `<any, any, any>`. */

import { getNodeById, type Block } from '@blocknote/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { createLogger } from '@/lib/logger'
import { serializeBlocksPreservingBlanks } from './markdown-utils'
import { getBlockSelection } from './marquee-block-registry'
import { topLevelSelectedBlockIds } from './hooks/use-block-marquee-selection'

const log = createLogger('BlockClipboard')

export interface BlockClipboardData {
  blocknoteHTML: string
  html: string
  markdown: string
}

interface ClipboardView {
  state: { doc: ProseMirrorNode }
  serializeForClipboard: (slice: Slice) => { dom: HTMLElement }
}

/**
 * Block ids a Copy from `blockId`'s handle copies: the whole marquee selection
 * when the block is part of it, otherwise the block alone. A selected child of
 * a selected parent drops out, since copying the parent already carries it.
 * Returned in document order.
 */
export function blockIdsToCopy(editor: any, blockId: string): string[] {
  const selected = getBlockSelection(editor)?.getIds() ?? []
  if (!selected.includes(blockId)) return [blockId]
  const document = Array.isArray(editor.document) ? editor.document : []
  const ids = topLevelSelectedBlockIds(document, new Set(selected))
  return ids.length > 0 ? ids : [blockId]
}

/**
 * The three clipboard flavours for `blockIds`, each block with its children.
 * Null when no id resolves to a block in the editor.
 */
export async function buildBlockClipboard(
  editor: any,
  blockIds: readonly string[]
): Promise<BlockClipboardData | null> {
  const view = editor.prosemirrorView as ClipboardView | undefined
  if (!view) return null

  const blocks = blockIds
    .map((id) => editor.getBlock(id) as Block | undefined)
    .filter((block): block is Block => block !== undefined)
  const nodes = blockIds
    .map((id) => getNodeById(id, view.state.doc)?.node)
    .filter((node): node is ProseMirrorNode => node !== undefined)
  if (blocks.length === 0 || nodes.length === 0) return null

  // A closed slice of whole block nodes: what a NodeSelection on one block
  // yields, extended to several. Unlike a text selection between the blocks it
  // cannot slide into a neighbour when the first or last block has no text
  // (an image, a file).
  const slice = new Slice(Fragment.fromArray(nodes), 0, 0)
  const blocknoteHTML = view.serializeForClipboard(slice).dom.innerHTML
  const html: string = editor.blocksToHTMLLossy(blocks)
  const markdown = (await serializeBlocksPreservingBlanks(editor, blocks)).trim()

  return { blocknoteHTML, html, markdown }
}

/**
 * Write the flavours to the system clipboard.
 *
 * `navigator.clipboard.write` only accepts standard types, so the
 * `blocknote/html` flavour needs a synchronous copy event. The listener sits on
 * `window` in the capture phase and stops the event there: the marquee hook's
 * document listener and ProseMirror's own copy handler would otherwise replace
 * the data with whatever they think is selected. If no copy event fires, the
 * standard flavours still go through the async API.
 */
export async function writeBlockClipboard(data: BlockClipboardData): Promise<void> {
  let written = false
  const onCopy = (event: ClipboardEvent): void => {
    if (!event.clipboardData) return
    event.stopImmediatePropagation()
    event.preventDefault()
    event.clipboardData.clearData()
    event.clipboardData.setData('blocknote/html', data.blocknoteHTML)
    event.clipboardData.setData('text/html', data.html)
    event.clipboardData.setData('text/plain', data.markdown)
    written = true
  }

  window.addEventListener('copy', onCopy, true)
  try {
    document.execCommand('copy')
  } finally {
    window.removeEventListener('copy', onCopy, true)
  }
  if (written) return

  log.debug('Copy event did not fire; writing standard clipboard flavours only')
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([data.html], { type: 'text/html' }),
      'text/plain': new Blob([data.markdown], { type: 'text/plain' })
    })
  ])
}

/**
 * Copy from `blockId`'s handle. Returns false when there was nothing to copy.
 * Throws when the clipboard write fails.
 */
export async function copyBlocksFromMenu(editor: any, blockId: string): Promise<boolean> {
  const data = await buildBlockClipboard(editor, blockIdsToCopy(editor, blockId))
  if (!data) return false
  await writeBlockClipboard(data)
  return true
}
