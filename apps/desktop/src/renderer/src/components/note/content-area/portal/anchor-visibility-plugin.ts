/**
 * The ` ^anchor` a block carries is plumbing, not prose: it stays in the
 * document and the markdown, and this plugin only hides it. It also keeps an
 * anchor on exactly one block.
 *
 * - The trailing ` ^anchor` of a block is hidden by an inline decoration. The
 *   text is still there, so a caret placed in it would type after the anchor
 *   and corrupt it; the caret is moved back to just before it, and the keys
 *   that would cross it (ArrowRight, Delete) are handled here.
 * - An anchor belongs to one block. When a local edit leaves it on another
 *   block, it goes back to the block that held it before:
 *   split mid-text      first half keeps it, the second half's copy is removed
 *   split at the start  the empty first half gives it to the second (the original text)
 *   join with a block   the merged text goes before it, the anchor stays last
 *   paste               a pasted block carrying an anchor the note already has
 *                       loses it (first in document order keeps it otherwise)
 *   range delete        deleting a range (Select-All, a selection, Cut) that
 *                       leaves a block with no visible text takes the anchor
 *                       with it: the block becomes a plain empty block. Typing
 *                       or pasting over the range, and deleting one character
 *                       at a caret, keep it.
 *   Remote changes (sync) are never rewritten.
 * - Typing cannot land after the anchor: the caret is moved to the visible end
 *   synchronously (keydown, beforeinput, compositionstart, paste, selectionchange)
 *   and text input / Backspace that arrive with the caret still past it are
 *   redirected to the visible end. Text that did land after a known anchor in
 *   a local transaction (`x ^dna1QQ`) is moved back before it.
 *
 * Wire-up: `createAnchorVisibilityExtension()` returns a tiptap extension for
 * the editors that build their own extension list; the portal window attaches
 * `createAnchorVisibilityPlugin()` directly.
 *
 * @module note/content-area/portal/anchor-visibility-plugin
 */

import { Extension } from '@tiptap/core'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from 'y-prosemirror'
import { extractAnchor } from '@memry/shared/portal-block'

export const ANCHOR_HIDDEN_CLASS = 'memry-anchor'

interface AnchorBlock {
  id: string
  /** Position of the content node (the textblock), not of its container. */
  pos: number
  node: PMNode
  anchor: string | null
}

interface AnchorScan {
  blocks: AnchorBlock[]
  decorations: DecorationSet
}

export const anchorVisibilityKey = new PluginKey<AnchorScan>('anchorVisibility')

/**
 * Meta on the transactions this plugin appends to put an anchor back. A portal
 * window's filters must let them through: right after a split the window
 * resolves blocks by anchor, so the block that kept the text (and is about to
 * get its anchor back) looks hidden, and refusing the repair would leave the
 * anchor on the new block and break every portal to the original.
 */
export function isAnchorRepair(tr: Transaction): boolean {
  return tr.getMeta(anchorVisibilityKey) === 'repair'
}

/** Document position of `offset` characters into a textblock's text. */
function posAtTextOffset(block: AnchorBlock, offset: number): number {
  let remaining = offset
  let pos = block.pos + 1
  if (offset === 0) return pos
  for (let i = 0; i < block.node.childCount; i += 1) {
    const child = block.node.child(i)
    const length = child.isText ? (child.text?.length ?? 0) : child.textContent.length
    if (remaining <= length && child.isText) return pos + remaining
    remaining -= length
    pos += child.nodeSize
  }
  return pos
}

/** Text range of the trailing ` ^anchor` (with its leading space) in a block's text. */
function trailingRange(block: AnchorBlock): { start: number; end: number } | null {
  if (!block.anchor) return null
  const text = block.node.textContent
  const at = text.lastIndexOf(`^${block.anchor}`)
  if (at < 0) return null
  return { start: at > 0 && /\s/.test(text[at - 1]) ? at - 1 : at, end: text.length }
}

function scan(doc: PMNode): AnchorScan {
  const blocks: AnchorBlock[] = []
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'blockContainer') return true
    const content = node.firstChild
    if (!content?.isTextblock || content.type.spec.code) return true
    const block: AnchorBlock = {
      id: String(node.attrs.id),
      pos: pos + 1,
      node: content,
      anchor: extractAnchor(content.textContent)
    }
    blocks.push(block)
    const range = trailingRange(block)
    if (range) {
      decorations.push(
        Decoration.inline(
          posAtTextOffset(block, range.start),
          posAtTextOffset(block, range.end),
          { class: ANCHOR_HIDDEN_CLASS, style: 'display: none' },
          { inclusiveStart: false, inclusiveEnd: false }
        )
      )
    }
    return true
  })
  return { blocks, decorations: DecorationSet.create(doc, decorations) }
}

/** The block whose text the caret is in, or null outside a block that can carry an anchor. */
function blockAtCaret($head: ResolvedPos): AnchorBlock | null {
  const node = $head.parent
  if (!node.isTextblock || node.type.spec.code || $head.depth < 1) return null
  if ($head.node($head.depth - 1).type.name !== 'blockContainer') return null
  return {
    id: String($head.node($head.depth - 1).attrs.id),
    pos: $head.before(),
    node,
    anchor: extractAnchor(node.textContent)
  }
}

/** Position just before the block's hidden anchor, or null when it has none. */
function visibleEnd(block: AnchorBlock): number | null {
  const range = trailingRange(block)
  return range ? posAtTextOffset(block, range.start) : null
}

/** End of the visible text of the textblock around `$pos`: before its hidden anchor, if any. */
export function anchorVisibleEnd($pos: ResolvedPos): number {
  const block = blockAtCaret($pos)
  return (block ? visibleEnd(block) : null) ?? $pos.end()
}

interface Edit {
  from: number
  to: number
  text: string
}

/** The block's text without its hidden trailing anchor. */
function visibleText(block: AnchorBlock): string {
  const range = trailingRange(block)
  const text = block.node.textContent
  return range ? text.slice(0, range.start) : text
}

/**
 * Blocks whose visible text one range deletion emptied. A deletion is a range
 * one when the selection before it was not a caret and no step puts text back,
 * so typing or pasting over a selection never counts.
 */
function emptiedByRangeDelete(
  trs: readonly Transaction[],
  oldState: EditorState,
  before: AnchorScan,
  after: AnchorScan
): Set<string> {
  const emptied = new Set<string>()
  if (oldState.selection.empty) return emptied
  const insertsText = trs.some((tr) =>
    tr.steps.some(
      (step) =>
        (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) &&
        step.slice.content.textBetween(0, step.slice.content.size) !== ''
    )
  )
  if (insertsText) return emptied
  const oldById = new Map(before.blocks.map((b) => [b.id, b]))
  for (const block of after.blocks) {
    const old = oldById.get(block.id)
    if (old?.anchor && visibleText(old).trim() !== '' && visibleText(block).trim() === '') {
      emptied.add(block.id)
    }
  }
  return emptied
}

/** Edits that put every anchor back on the one block that owns it. */
function anchorFixes(
  before: AnchorScan,
  after: AnchorScan,
  rangeEmptied: ReadonlySet<string>
): Edit[] {
  const edits: Edit[] = []
  const byId = new Map(after.blocks.map((b) => [b.id, b]))
  const holders = new Map<string, AnchorBlock[]>()
  for (const block of after.blocks) {
    if (block.anchor) holders.set(block.anchor, [...(holders.get(block.anchor) ?? []), block])
  }
  const oldOwner = new Map<string, string>()
  for (const block of before.blocks) {
    if (block.anchor && !oldOwner.has(block.anchor)) oldOwner.set(block.anchor, block.id)
  }

  const strip = (block: AnchorBlock): void => {
    const range = trailingRange(block)
    if (!range) return
    edits.push({
      from: posAtTextOffset(block, range.start),
      to: posAtTextOffset(block, range.end),
      text: ''
    })
  }

  // The user deleted the text of these blocks in one range operation: the
  // anchor goes with it, and is not restored below.
  const released = new Set<string>()
  for (const id of rangeEmptied) {
    const block = byId.get(id)
    if (block?.anchor) strip(block)
    const anchor = before.blocks.find((b) => b.id === id)?.anchor
    if (anchor) released.add(anchor)
  }

  for (const [anchor, group] of holders) {
    if (released.has(anchor)) continue
    const ownerId = oldOwner.get(anchor)
    const keeper = (ownerId && group.find((b) => b.id === ownerId)) || group[0]
    const owner = ownerId ? byId.get(ownerId) : undefined
    if (owner && !group.includes(owner)) continue
    for (const block of group) if (block !== keeper) strip(block)
  }

  for (const [anchor, ownerId] of oldOwner) {
    if (released.has(anchor)) continue
    const owner = byId.get(ownerId)
    const group = holders.get(anchor) ?? []
    if (!owner) {
      // The owner is gone (merged away). A token left in the middle of text is debris.
      for (const block of after.blocks) {
        if (block.anchor === anchor) continue
        const hit = new RegExp(`(^|\\s)\\^${anchor}(?![a-z0-9-])`).exec(block.node.textContent)
        if (hit) {
          const from = hit.index + (hit[1] ? 1 : 0)
          edits.push({
            from: posAtTextOffset(block, hit.index),
            to: posAtTextOffset(block, from + 1 + anchor.length),
            text: ''
          })
        }
      }
      continue
    }
    if (owner.anchor === anchor) continue
    // Split at the very start: the owner is the empty first half and the text
    // (with its anchor) moved to the second. The anchor stays with the text.
    if (owner.node.textContent.trim() === '' && group.length === 1) continue
    // The owner lost the anchor: to a split-off block, or into the text of a join.
    for (const block of group) strip(block)
    const text = owner.node.textContent
    const mid = new RegExp(`(^|\\s)\\^${anchor}`).exec(text)
    if (mid) {
      edits.push({
        from: posAtTextOffset(owner, mid.index),
        to: posAtTextOffset(owner, mid.index + mid[0].length),
        text: ''
      })
    }
    edits.push({
      from: posAtTextOffset(owner, text.length),
      to: posAtTextOffset(owner, text.length),
      text: ` ^${anchor}`
    })
  }
  return edits
}

interface Heal {
  block: AnchorBlock
  anchor: string
  /** Text offsets in the block: where ` ^anchor` starts and where the extra text starts and ends. */
  anchorStart: number
  extraStart: number
  extraEnd: number
}

/**
 * A block that was `<visible> ^A` and is now `<visible> ^A<extra>`: typing landed
 * after its hidden anchor. Only the anchor the block carried before counts, so
 * text that merely contains something anchor-like is left alone.
 */
function findHeal(before: AnchorScan, after: AnchorScan): Heal | null {
  const oldById = new Map(before.blocks.map((b) => [b.id, b]))
  for (const block of after.blocks) {
    const old = oldById.get(block.id)
    if (!old?.anchor || block.anchor === old.anchor) continue
    const tail = `^${old.anchor}`
    if (!old.node.textContent.endsWith(tail)) continue
    const text = block.node.textContent
    const at = text.lastIndexOf(tail)
    if (at < 0 || at + tail.length >= text.length) continue
    if (at > 0 && !/\s/.test(text[at - 1])) continue
    return {
      block,
      anchor: old.anchor,
      anchorStart: at > 0 ? at - 1 : at,
      extraStart: at + tail.length,
      extraEnd: text.length
    }
  }
  return null
}

/** One transaction that moves the extra text before the anchor and keeps the caret after it. */
function healTransaction(state: EditorState, heal: Heal): Transaction {
  const { block } = heal
  const extraFrom = posAtTextOffset(block, heal.extraStart)
  const extraTo = posAtTextOffset(block, heal.extraEnd)
  const insertAt = posAtTextOffset(block, heal.anchorStart)
  const extra = state.doc.slice(extraFrom, extraTo).content
  const caretInExtra = state.selection.empty && state.selection.head >= extraFrom
  const tr = state.tr.delete(extraFrom, extraTo).insert(insertAt, extra)
  tr.setMeta(anchorVisibilityKey, 'repair')
  if (caretInExtra && state.selection.head <= extraTo) {
    tr.setSelection(TextSelection.create(tr.doc, insertAt + extra.size))
  }
  return tr
}

function isLocalDocChange(tr: Transaction): boolean {
  return tr.docChanged && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin
}

/** The caret, when it sits inside a hidden anchor, moved to just before it. */
function snapCaret(selection: Selection): number | null {
  if (!selection.empty) return null
  const block = blockAtCaret(selection.$head)
  const end = block ? visibleEnd(block) : null
  return end !== null && selection.head > end ? end : null
}

/**
 * Moves a caret that is in, or (per the DOM) after, a hidden anchor to the
 * visible end right now. The DOM selection is read directly because it can be
 * ahead of the editor state when keys arrive faster than selectionchange is
 * processed.
 */
function snapToVisibleEnd(view: EditorView): void {
  const state = view.state
  let target = snapCaret(state.selection)
  if (target === null && view.hasFocus()) {
    const dom = view.dom.ownerDocument.getSelection()
    if (dom?.isCollapsed && dom.anchorNode && view.dom.contains(dom.anchorNode)) {
      const head = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
      const block = blockAtCaret(state.doc.resolve(head))
      const end = block ? visibleEnd(block) : null
      if (end !== null && head > end) target = end
    }
  }
  if (target === null) return
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)))
}

export function createAnchorVisibilityPlugin(): Plugin<AnchorScan> {
  return new Plugin<AnchorScan>({
    key: anchorVisibilityKey,
    state: {
      init: (_config, state) => scan(state.doc),
      apply: (tr, value) => (tr.docChanged ? scan(tr.doc) : value)
    },
    props: {
      decorations: (state) => anchorVisibilityKey.getState(state)?.decorations ?? null,
      handleKeyDown(view, event) {
        snapToVisibleEnd(view)
        const { selection } = view.state
        const block = selection.empty ? blockAtCaret(selection.$head) : null
        const end = block ? visibleEnd(block) : null
        if (!block || end === null) return false
        const lineEnd =
          !event.shiftKey &&
          !event.altKey &&
          ((event.key === 'End' && !event.metaKey) ||
            (event.key === 'ArrowRight' && event.metaKey && !event.ctrlKey))
        if (lineEnd && selection.head !== end && view.endOfTextblock('down')) {
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, end)))
          return true
        }
        if (selection.head < end) return false
        const plain = !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey
        if (!plain) return false
        if (event.key === 'Backspace') {
          // Native Backspace after a hidden span would eat the anchor.
          const $end = view.state.doc.resolve(end)
          const prev = $end.nodeBefore
          if (!prev || $end.parentOffset === 0) return false
          let size = prev.nodeSize
          if (prev.isText) {
            const text = prev.text ?? ''
            const low = text.charCodeAt(text.length - 1)
            size = low >= 0xdc00 && low <= 0xdfff && text.length > 1 ? 2 : 1
          }
          view.dispatch(view.state.tr.delete(end - size, end).scrollIntoView())
          return true
        }
        if (event.key !== 'ArrowRight' && event.key !== 'Delete') return false
        // Past the visible text is past the block: cross it, never into the anchor.
        if (event.key === 'Delete') return true
        const blockEnd = block.pos + block.node.nodeSize
        const next = Selection.findFrom(view.state.doc.resolve(blockEnd), 1, true)
        if (next) view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
        return next !== null
      },
      handleTextInput(view, from, to, text) {
        const block = blockAtCaret(view.state.doc.resolve(from))
        const end = block ? visibleEnd(block) : null
        if (end === null || to < end || from > to) return false
        const { doc } = view.state
        if (doc.resolve(to).parent !== doc.resolve(from).parent) return false
        // Typing at or after the hidden anchor, or over a range that reaches into it: the visible end.
        if (from < end && to === end) return false
        const start = Math.min(from, end)
        const tr = view.state.tr.insertText(text, start, end)
        view.dispatch(tr.setSelection(TextSelection.create(tr.doc, start + text.length)))
        return true
      },
      handlePaste(view) {
        snapToVisibleEnd(view)
        return false
      },
      handleDOMEvents: {
        beforeinput: (view) => {
          snapToVisibleEnd(view)
          return false
        },
        compositionstart: (view) => {
          snapToVisibleEnd(view)
          return false
        }
      }
    },
    view(view) {
      const doc = view.dom.ownerDocument
      const onSelectionChange = (): void => snapToVisibleEnd(view)
      doc.addEventListener('selectionchange', onSelectionChange)
      return { destroy: () => doc.removeEventListener('selectionchange', onSelectionChange) }
    },
    appendTransaction(trs, oldState, newState) {
      const before = anchorVisibilityKey.getState(oldState)
      const after = anchorVisibilityKey.getState(newState)
      if (!before || !after) return null
      let tr: Transaction | null = null
      if (trs.some(isLocalDocChange)) {
        const heal = findHeal(before, after)
        if (heal) return healTransaction(newState, heal)
        const rangeEmptied = emptiedByRangeDelete(trs, oldState, before, after)
        const edits = anchorFixes(before, after, rangeEmptied).sort((a, b) => b.from - a.from)
        if (edits.length > 0) {
          tr = newState.tr.setMeta(anchorVisibilityKey, 'repair')
          for (const edit of edits) {
            if (edit.text) tr.insert(edit.from, newState.schema.text(edit.text))
            else tr.delete(edit.from, edit.to)
          }
        }
      }
      const snapped = snapCaret((tr ?? newState).selection)
      if (snapped !== null) {
        tr ??= newState.tr
        tr.setSelection(TextSelection.create(tr.doc, snapped))
      }
      return tr
    }
  })
}

/** The plugin as a tiptap extension, for editors that assemble their own extension list. */
export function createAnchorVisibilityExtension(): Extension {
  return Extension.create({
    name: 'memryAnchorVisibility',
    addProseMirrorPlugins: () => [createAnchorVisibilityPlugin()]
  })
}
