/**
 * Landing the user back in the note.
 *
 * Two steps, and both are load-bearing. The map does not sit beside the note,
 * it sits on top of it: the body is hidden (kept mounted, so the editor and its
 * undo history survive) and nothing inside a hidden body can be scrolled into
 * the user's view. So the map closes first. And the block may not be in the
 * document yet — `ContentArea` holds its render behind a placeholder until the
 * CRDT binding settles — which is why a miss falls through to the waiting form
 * rather than giving up.
 *
 * The immediate lookup is tried first on purpose. Coming from the map the block
 * is almost always already there, having been rendered behind the picture the
 * whole time, and a single call is what keeps the outline panel's smooth jump
 * exactly as smooth as it was before this existed.
 *
 * The outline panel gets its OWN entry point rather than this one, and the split
 * is the point. A box on the map is a place in the note — clicking it means "take
 * me there", so it closes the map. An entry in the outline, while the map is
 * open, is a place on the MAP — the panel sits above the picture on purpose, and
 * on a map too big to see at once it is the only way to reach a far branch. So
 * that click moves the camera and leaves the map open. Same destination, two
 * different intents, and widening one function to serve both would have made
 * clicking a node stop navigating.
 *
 * The outline falls back to this one whenever the map cannot answer: closed, not
 * yet mounted, or asked for a block it did not draw (folded behind a "+N more",
 * or dropped at the node cap). That fallback IS the old behaviour, so a heading
 * click never does nothing.
 *
 * Two node kinds do not land in this note at all — a wiki link opens the note
 * it names, a task opens its task — and neither closes the map. They are handed
 * straight to the note page's own handlers for those things, so the map has no
 * opening behaviour of its own to drift from the rest of the app.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { RESTORE_MAX_MS } from '@/hooks/use-tab-scroll-restore'
import { scrollToHeadingBlock, scrollToHeadingWhenReady } from '@/lib/scroll-to-heading'
import { activateMindMapNode, type MindMapNodeActivation } from './mind-map-navigation'

interface UseMindMapNavigationOptions {
  /** Closes the map. A no-op when it is already closed. */
  close: () => void
  /**
   * Opens the branch a "+N more" node stands for, in place. The one node kind
   * that does not close the map: a fold is undone where it is, not by leaving.
   */
  expandBranch: (nodeId: string) => void
  /** The pane the block lives in — never the document, which in split view
   * would scroll whichever pane comes first rather than this one. */
  getContainer: () => HTMLElement | null
  /** The top of the note: where the root node, which is the title, lands. */
  getTopElement: () => HTMLElement | null
  /** False when the user asked for less motion. */
  smooth: boolean
  /**
   * The note page's own wiki-link handler, taking the target as written. Passed
   * in rather than rebuilt so the map opens a link through the one path that
   * already resolves it, creates it when it is missing, and honours the
   * open-in-new-tab preference.
   */
  openNote: (wikiTarget: string) => void
  /** The note page's own task handler. */
  openTask: (taskId: string) => void
  /**
   * Moves the open map's camera onto a block, and answers whether it could.
   * False for a closed map, a surface that has not mounted yet, and a block the
   * map did not draw.
   */
  focusBlock: (blockId: string) => boolean
}

export interface UseMindMapNavigationResult {
  /**
   * Close the map and land at this block. `null` is the top of the note.
   * What a map node's activation ends in.
   */
  navigateToBlock: (blockId: string | null) => void
  /**
   * A heading click in the outline panel. Moves the camera when the map is
   * showing that block, and otherwise behaves exactly like `navigateToBlock`.
   */
  navigateFromOutline: (blockId: string) => void
  /** What a node activation on either projection ends in. */
  activateNode: MindMapNodeActivation
}

export function useMindMapNavigation({
  close,
  expandBranch,
  getContainer,
  getTopElement,
  smooth,
  openNote,
  openTask,
  focusBlock
}: UseMindMapNavigationOptions): UseMindMapNavigationResult {
  // A wait outlives the click that started it, so a second click — or leaving
  // the note — has to call the first one off, or two of them fight over the
  // scroll offset for as long as the deadline lasts.
  const cancelPendingRef = useRef<(() => void) | null>(null)
  const cancelPending = useCallback(() => {
    cancelPendingRef.current?.()
    cancelPendingRef.current = null
  }, [])

  useEffect(() => cancelPending, [cancelPending])

  const navigateToBlock = useCallback(
    (blockId: string | null) => {
      cancelPending()
      close()

      if (blockId === null) {
        getTopElement()?.scrollIntoView?.({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
        return
      }

      if (scrollToHeadingBlock(getContainer(), blockId, { smooth })) return

      // Not rendered yet. Never smooth from here: there is no starting position
      // for an animation to be relative to when the content has not arrived.
      cancelPendingRef.current = scrollToHeadingWhenReady({
        getContainer,
        getHeadingId: () => blockId,
        smooth: false,
        timeoutMs: RESTORE_MAX_MS,
        onSettled: () => {
          cancelPendingRef.current = null
        }
      })
    },
    [cancelPending, close, getContainer, getTopElement, smooth]
  )

  const navigateFromOutline = useCallback(
    (blockId: string) => {
      // Nothing to call off and nothing to close on this path: the camera move
      // is instantaneous and leaves the note exactly where it was, so a pending
      // scroll from an earlier click is not something this one invalidates.
      if (focusBlock(blockId)) return
      navigateToBlock(blockId)
    },
    [focusBlock, navigateToBlock]
  )

  const activateNode = useCallback<MindMapNodeActivation>(
    (node) => activateMindMapNode(node, { navigateToBlock, openNote, openTask, expandBranch }),
    [navigateToBlock, openNote, openTask, expandBranch]
  )

  return useMemo(
    () => ({ navigateToBlock, navigateFromOutline, activateNode }),
    [navigateToBlock, navigateFromOutline, activateNode]
  )
}
