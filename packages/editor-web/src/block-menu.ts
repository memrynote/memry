/**
 * The block actions menu: entry points, highlight, and the move round trip (#2100).
 *
 * Shaped like `installFindInNote` / `installDateMentionSheet` — one installer,
 * one controller, its own bridge listener — so `main.ts`'s message switch does
 * not grow and the whole thing can be driven from a jsdom test.
 *
 * It owns exactly four things: building the `BlockActionTarget` both entry
 * points share, the highlight on the addressed block, the long-press gesture
 * with its two gates, and the single pending move.
 */

import type { GuestMsg, HostMsg } from '@memry/contracts/webview-bridge'

import {
  blockCapabilities,
  LONG_PRESS_BLOCK_TYPES,
  type BlockAction,
  type BlockActionTarget,
  type BlockLikeForCaps,
  type SchemaLikeForCaps
} from './block-capabilities.ts'
import { runBlockAction, type BlockActionEditorSurface } from './block-actions.ts'
import { readColour } from './block-styles.ts'
import type { BlockActionsPanelController } from './block-actions-panel.ts'
import { scrollBehavior } from './reduced-motion.ts'
import { isForMountedDoc } from './routing.ts'

/** iOS's own long-press threshold. Shorter fires while the reader is scrolling. */
const LONG_PRESS_DELAY_MS = 450

/** A finger never sits still. Past this the press was the start of a scroll. */
const LONG_PRESS_TOLERANCE_PX = 10

/**
 * The highlight.
 *
 * A live attribute on the block's own element rather than a positioned
 * overlay: an overlay freezes a measured rect and drifts the moment the
 * document reflows or the reader scrolls.
 */
const HIGHLIGHT_ATTRIBUTE = 'data-memry-block-action'

/** Breathing room between the addressed block and the panel's top edge. */
const SCROLL_MARGIN_PX = 12

/** The narrow slice of the bridge. The real `GuestBridge` satisfies it. */
export interface BlockMenuBridge {
  send(msg: GuestMsg): void
  flush(): void
  onHostMsg(listener: (msg: HostMsg) => void): () => void
}

export interface BlockMenuEditorSurface extends BlockActionEditorSurface {
  schema: SchemaLikeForCaps
  getTextCursorPosition(): { block: { id: string } }
}

export interface BlockMenuController {
  /** The toolbar's `•••`: open for whatever block the caret is in. */
  openForCaret(): void
  /** Dispatch from the panel. Named blockId, never "the current block". */
  run(blockId: string, action: BlockAction): void
  setReadOnly(readOnly: boolean): void
  destroy(): void
}

/**
 * How much of the viewport's bottom the open panel covers.
 *
 * MEASURED, because the panel sizes to its content. The sheet renders
 * synchronously from `openBlockActions`, so by the time this is called the
 * panel is in the document and has a box; zero is what jsdom and a
 * `display: none` chrome layer both look like, and then there is nothing to
 * scroll clear of.
 */
function readPanelHeight(): number {
  return document.querySelector('.editor-block-actions-shell')?.getBoundingClientRect().height ?? 0
}

/**
 * A press held still for `delayMs`.
 *
 * `pointer*` rather than `touch*`, for the reason the toolbar's buttons use it:
 * iOS relocates `contenteditable=false` nodes under a `click`. Cancelled by
 * movement past the tolerance, by the press ending, and by a scroll starting —
 * a page that moved under the finger was never a press on one block.
 */
function installLongPress(
  root: HTMLElement,
  onPress: (target: EventTarget | null) => void,
  options: { delayMs: number; tolerancePx: number }
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let origin: { x: number; y: number } | null = null

  const cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    origin = null
  }

  const onPointerDown = (event: PointerEvent): void => {
    cancel()
    if (event.button !== 0) return
    origin = { x: event.clientX, y: event.clientY }
    const target = event.target
    timer = setTimeout(() => {
      timer = null
      origin = null
      onPress(target)
    }, options.delayMs)
  }

  const onPointerMove = (event: PointerEvent): void => {
    if (timer === null || origin === null) return
    if (
      Math.abs(event.clientX - origin.x) > options.tolerancePx ||
      Math.abs(event.clientY - origin.y) > options.tolerancePx
    ) {
      cancel()
    }
  }

  root.addEventListener('pointerdown', onPointerDown)
  root.addEventListener('pointermove', onPointerMove)
  root.addEventListener('pointerup', cancel)
  root.addEventListener('pointercancel', cancel)
  // Capture, and on the window: the scroller is the document, so a scroll that
  // starts under the finger never reaches a listener bound to `root`.
  window.addEventListener('scroll', cancel, true)

  return () => {
    cancel()
    root.removeEventListener('pointerdown', onPointerDown)
    root.removeEventListener('pointermove', onPointerMove)
    root.removeEventListener('pointerup', cancel)
    root.removeEventListener('pointercancel', cancel)
    window.removeEventListener('scroll', cancel, true)
  }
}

export function installBlockMenu(options: {
  root: HTMLElement
  editor: BlockMenuEditorSurface
  panel: BlockActionsPanelController
  bridge: BlockMenuBridge
  docId: string
}): BlockMenuController {
  const { root, editor, panel, bridge, docId } = options

  let readOnly = false
  let addressed: string | null = null
  /**
   * The one move in flight.
   *
   * Held here rather than in the panel's view state, because the panel closes
   * the instant Move is tapped — the picker is a native Modal over the whole
   * screen — while the highlight and this slot survive until the answer lands.
   */
  let pendingMove: { reqId: string; blockId: string } | null = null
  let reqCounter = 0

  const blockElement = (blockId: string): HTMLElement | null => {
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(blockId) : blockId
    return root.querySelector<HTMLElement>(`.bn-block-outer[data-id="${escaped}"]`)
  }

  /**
   * Ring exactly one block, or none.
   *
   * Re-applied after every applied action rather than set once: a ProseMirror
   * re-render can recreate the node the attribute was written on.
   */
  const paintAddressed = (blockId: string | null): void => {
    for (const painted of root.querySelectorAll(`[${HIGHLIGHT_ATTRIBUTE}]`)) {
      painted.removeAttribute(HIGHLIGHT_ATTRIBUTE)
    }
    addressed = blockId
    if (blockId === null) return
    blockElement(blockId)?.setAttribute(HIGHLIGHT_ATTRIBUTE, '')
  }

  /**
   * Bring the addressed block clear of the panel that is about to cover the
   * keyboard's slot, so the colour rows can be nudged and looked at.
   *
   * A zero-height rect means the element is not laid out — there is nothing to
   * bring into view, and scrolling to a rect of zeroes would jump the note to
   * the top for no reason.
   */
  const scrollAddressedIntoView = (blockId: string): void => {
    const element = blockElement(blockId)
    if (!element) return
    const rect = element.getBoundingClientRect()
    if (rect.height <= 0) return
    const top = SCROLL_MARGIN_PX
    const bottom = window.innerHeight - readPanelHeight() - SCROLL_MARGIN_PX
    if (bottom <= top) return
    const delta = rect.bottom > bottom ? rect.bottom - bottom : rect.top < top ? rect.top - top : 0
    if (delta === 0) return
    window.scrollBy({ top: delta, behavior: scrollBehavior() })
  }

  const buildTarget = (blockId: string): BlockActionTarget | null => {
    const block = editor.getBlock(blockId)
    if (!block) return null
    const props = block.props as { textColor?: unknown; backgroundColor?: unknown }
    return {
      blockId,
      caps: blockCapabilities(block as unknown as BlockLikeForCaps, editor.schema),
      textColour: readColour(props.textColor),
      backgroundColour: readColour(props.backgroundColor)
    }
  }

  /**
   * The panel addressing this block went away — Done, a keyboard coming back,
   * read-only, or an action that finished. A move in flight keeps the ring:
   * the reader is looking at a note picker and has to know which block travels.
   */
  const onPanelClose = (): void => {
    if (pendingMove) return
    paintAddressed(null)
  }

  const open = (blockId: string): void => {
    const target = buildTarget(blockId)
    if (!target) return
    paintAddressed(blockId)
    panel.openBlockActions(target, onPanelClose)
    scrollAddressedIntoView(blockId)
  }

  const onLongPress = (target: EventTarget | null): void => {
    if (readOnly || !(target instanceof Element)) return
    const holder = target.closest('[data-id]')
    const blockId = holder?.getAttribute('data-id')
    if (!holder || !blockId) return

    /*
     * Gate 1: editable text INSIDE the addressed block — the loupe's territory.
     *
     * Scoped to the block deliberately. ProseMirror puts `contenteditable="true"`
     * on the editor ROOT and every block is inside it, and this BlockNote build
     * puts the attribute nowhere else: an image's content div, a divider's, a
     * table's cell all carry none at all (verified against a mounted editor in
     * `block-menu-real-editor.test.ts`). An unscoped `closest('[contenteditable]')`
     * therefore answers `true` for every press in the document and would refuse
     * a long-press on an image as readily as one on a paragraph.
     *
     * So this fires only for an editable run the block owns — which today is
     * nothing, because a file caption renders as a prop-driven `<p>`. It is kept
     * because the day one of those becomes independently editable is the day a
     * long-press there must go back to the loupe, and that day should not need
     * this rule rediscovered.
     */
    const editable = target.closest('[contenteditable]')
    if (
      editable &&
      holder.contains(editable) &&
      editable.getAttribute('contenteditable') === 'true'
    )
      return

    /*
     * Gate 2, and the one that carries the weight: a type long-press may
     * address at all. Every text block is out because its type is not in the
     * set, and so is `table`, whose CELLS are editable text — it stays
     * reachable from the toolbar's `•••`.
     */
    const block = editor.getBlock(blockId)
    if (!block || !LONG_PRESS_BLOCK_TYPES.has(block.type)) return
    open(blockId)
  }

  const requestMove = (target: BlockActionTarget): void => {
    const reqId = `bm${++reqCounter}`
    // Set BEFORE the panel closes: `onPanelClose` reads it to decide whether the
    // ring stays up.
    pendingMove = { reqId, blockId: target.blockId }
    bridge.send({
      type: 'block-move-request',
      reqId,
      docId,
      blockId: target.blockId,
      // The label the panel is already showing, not a second derivation of it.
      label: target.caps.label
    })
    // The host cannot open a picker it has not been asked for, and the panel is
    // already on its way out — there is nothing left to batch behind.
    bridge.flush()
    panel.closePanel()
  }

  const detachLongPress = installLongPress(root, onLongPress, {
    delayMs: LONG_PRESS_DELAY_MS,
    tolerancePx: LONG_PRESS_TOLERANCE_PX
  })

  const detachHostMsg = bridge.onHostMsg((msg) => {
    if (msg.type !== 'block-move-result') return
    // Through `isForMountedDoc` rather than a second hand-written comparison:
    // this listener sits on the bridge directly, so `main.ts`'s switch never
    // sees the message, and routing.ts's strict arm would otherwise be dead
    // code that could disagree with the check that actually runs.
    if (!isForMountedDoc(msg, docId)) return
    // A reply that outlived its request, or a second reply to one already
    // answered. Removing a block on it would delete something the reader never
    // asked to move.
    if (!pendingMove || msg.reqId !== pendingMove.reqId) return
    pendingMove = null
    if (msg.result.status === 'moved') {
      // The target already holds a durable copy, so this is the SECOND half of
      // a move whose first half cannot be rolled back. `msg.blockId`, not the
      // slot's: the answer names its own target.
      const block = editor.getBlock(msg.blockId)
      if (block) editor.removeBlocks([block])
    }
    // `cancelled` and `failed` both keep the block; the host owns telling the
    // reader why a failure failed.
    paintAddressed(null)
  })

  return {
    openForCaret(): void {
      if (readOnly) return
      open(editor.getTextCursorPosition().block.id)
    },
    run(blockId: string, action: BlockAction): void {
      if (readOnly) return
      if (action.kind === 'move') {
        // `null` when the block has left the document — a pull, an undo, a
        // second tap. Asking the host to move it would answer with a delete of
        // nothing and a toast naming a block the reader can no longer see.
        const target = buildTarget(blockId)
        if (!target) {
          paintAddressed(null)
          panel.closePanel()
          return
        }
        requestMove(target)
        return
      }

      const outcome = runBlockAction(editor, blockId, action)
      if (outcome.status === 'applied' && outcome.keepOpen) {
        const target = buildTarget(blockId)
        if (target) {
          paintAddressed(blockId)
          panel.openBlockActions(target, onPanelClose)
          return
        }
      }
      paintAddressed(null)
      panel.closePanel()
    },
    setReadOnly(next: boolean): void {
      readOnly = next
      if (!next) return
      // The panel closes itself on read-only; this drops what it was about.
      pendingMove = null
      paintAddressed(null)
    },
    destroy(): void {
      detachLongPress()
      detachHostMsg()
      pendingMove = null
      if (addressed !== null) paintAddressed(null)
    }
  }
}
