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
 *   join with a block   the merged text goes before it, the anchor stays last
 *   paste               a pasted block carrying an anchor the note already has
 *                       loses it (first in document order keeps it otherwise)
 *   Remote changes (sync) are never rewritten.
 *
 * Wire-up: `createAnchorVisibilityExtension()` returns a tiptap extension for
 * the editors that build their own extension list; the portal window attaches
 * `createAnchorVisibilityPlugin()` directly.
 *
 * @module note/content-area/portal/anchor-visibility-plugin
 */

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
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

/** Edits that put every anchor back on the one block that owns it. */
function anchorFixes(before: AnchorScan, after: AnchorScan): Edit[] {
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

  for (const [anchor, group] of holders) {
    const ownerId = oldOwner.get(anchor)
    const keeper = (ownerId && group.find((b) => b.id === ownerId)) || group[0]
    const owner = ownerId ? byId.get(ownerId) : undefined
    if (owner && !group.includes(owner)) continue
    for (const block of group) if (block !== keeper) strip(block)
  }

  for (const [anchor, ownerId] of oldOwner) {
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
        if (event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return false
        if (event.key !== 'ArrowRight' && event.key !== 'Delete') return false
        const { selection } = view.state
        const block = selection.empty ? blockAtCaret(selection.$head) : null
        if (!block || selection.head !== visibleEnd(block)) return false
        // Past the visible text is past the block: cross it, never into the anchor.
        if (event.key === 'Delete') return true
        const end = block.pos + block.node.nodeSize
        const next = Selection.findFrom(view.state.doc.resolve(end), 1, true)
        if (next) view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
        return next !== null
      }
    },
    appendTransaction(trs, oldState, newState) {
      const before = anchorVisibilityKey.getState(oldState)
      const after = anchorVisibilityKey.getState(newState)
      if (!before || !after) return null
      let tr: Transaction | null = null
      if (trs.some(isLocalDocChange)) {
        const edits = anchorFixes(before, after).sort((a, b) => b.from - a.from)
        if (edits.length > 0) {
          tr = newState.tr
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
