/**
 * The link affordance for a saved mind map's boxes.
 *
 * A canvas minted from a note's mind map (`mind-map-snapshot.ts`) carries each
 * box's `memry://` href in `customData`, not in `element.link`. That is not a
 * detail of the file format, it is the whole reason this file exists: the
 * drawing library paints a permanent blue glyph on every element that has a
 * `link`, hover-gated by nothing and suppressible by no prop, appState field or
 * CSS surface. On a canvas where a handful of shapes are linked that glyph
 * marks something. On a map, where every single box is, it marks nothing and
 * buries the one thing the picture is for — its shape.
 *
 * So a saved map keeps its href where nothing paints it, and this layer renders
 * what that field was buying: a hover card naming the destination, and a way to
 * open it. Same hit test and same anchor math as the drawn map
 * (`mind-map-hover.ts`), so a map reads the same way after it is saved as it
 * did while it was drawn — which is the entire point.
 *
 * One thing is deliberately NOT the same. The drawn map is read-only, so the
 * whole box is a click target there; here a box is a shape the user can select,
 * drag, restyle and delete, and stealing its clicks would take the canvas away
 * from them. The CARD is the control instead: hovering names the destination,
 * clicking the card opens it.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { viewportCoordsToSceneCoords } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useT } from '@memry/i18n/renderer'
import { Link } from '@/lib/icons'
import {
  hitMindMapBox,
  mindMapHoverAnchor,
  type MindMapHitElement
} from '@/components/note/mind-map/mind-map-hover'
import { linkBubbleLabel, truncateLabel } from './canvas-link-label'

interface HoverState {
  href: string
  /** Pixels from the drawing surface's own origin. See `mindMapHoverAnchor`. */
  x: number
  y: number
}

/** The slice of a scene element this layer reads on top of the hit test's own. */
type SceneElement = MindMapHitElement & { link?: string | null }

interface CanvasNodeLinkLayerProps {
  excalidrawAPI: ExcalidrawImperativeAPI
  /** Wrapper element hosting the canvas — the pointer listeners attach here. */
  wrapperRef: React.RefObject<HTMLDivElement | null>
  /** Opens the href, through the editor's own link handling. */
  onOpen: (href: string) => void
}

export const CanvasNodeLinkLayer = ({
  excalidrawAPI,
  wrapperRef,
  onOpen
}: CanvasNodeLinkLayerProps): React.JSX.Element | null => {
  const { t } = useT('common')
  const [hovered, setHovered] = useState<HoverState | null>(null)
  /** Last seen pointer, so a pan or a zoom can re-answer without a mouse move. */
  const pointerRef = useRef<{ clientX: number; clientY: number } | null>(null)
  /** The card's own element, so a pointer that moved ONTO it is not a miss. */
  const cardRef = useRef<HTMLButtonElement | null>(null)
  const frameRef = useRef<number | null>(null)

  /**
   * The box under the last known pointer, or null.
   *
   * Read from the LIVE scene, and answered only while the canvas is idle: a
   * pointer that is drawing, dragging or resizing is doing something to the
   * document, and a card that appeared under it would be an invitation to
   * misclick. An element that carries a real `element.link` as well is left to
   * the library — that one has a glyph, and two affordances for one link is
   * worse than either.
   */
  const hitAtPointer = useCallback((): HoverState | null => {
    const pointer = pointerRef.current
    if (!pointer) return null

    const appState = excalidrawAPI.getAppState()
    if (appState.activeTool.type !== 'selection') return null
    if (appState.selectedElementsAreBeingDragged || appState.resizingElement) return null

    const elements = excalidrawAPI.getSceneElements() as unknown as readonly SceneElement[]
    const scene = viewportCoordsToSceneCoords(pointer, appState)
    const hit = hitMindMapBox(
      elements.filter((element) => !element.link),
      scene
    )
    if (!hit) return null

    const anchor = mindMapHoverAnchor(hit, appState)
    return { href: hit.href, x: anchor.x, y: anchor.y }
  }, [excalidrawAPI])

  const syncHover = useCallback((): void => {
    const next = hitAtPointer()
    // Same box, same place — hand back the very same object so React does not
    // re-render. Moving the pointer inside one node then costs nothing at all.
    setHovered((current) =>
      current && next && current.href === next.href && current.x === next.x && current.y === next.y
        ? current
        : next
    )
  }, [hitAtPointer])

  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) return

    const onPointerMove = (event: PointerEvent): void => {
      // The card sits over the surface, so a pointer on it reaches this
      // listener too — and hit-testing there would answer "nothing", clearing
      // the very card the pointer is travelling to.
      if (event.target instanceof Node && cardRef.current?.contains(event.target)) return
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
      syncHover()
    }
    const onPointerLeave = (): void => {
      pointerRef.current = null
      setHovered(null)
    }

    // Capture phase: these have to answer whatever the drawing surface does
    // with the event afterwards.
    wrapper.addEventListener('pointermove', onPointerMove, true)
    wrapper.addEventListener('pointerleave', onPointerLeave)
    return () => {
      wrapper.removeEventListener('pointermove', onPointerMove, true)
      wrapper.removeEventListener('pointerleave', onPointerLeave)
    }
  }, [syncHover, wrapperRef])

  /**
   * A pan, a zoom or a drag moves the drawing under a pointer that never moved,
   * so the answer has to be recomputed from a change rather than from a mouse
   * event. Coalesced onto a frame because the library reports every committed
   * state change, a pan tick included, and each answer costs a scene read.
   */
  useEffect(() => {
    const unsubscribe = excalidrawAPI.onChange(() => {
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        syncHover()
      })
    })
    return () => {
      unsubscribe()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [excalidrawAPI, syncHover])

  if (!hovered) return null

  // The label the href froze into itself when the map was saved. A box written
  // before labels existed falls back to the href, which is the honest answer:
  // it is all that box has ever carried.
  const name = linkBubbleLabel(hovered.href) ?? truncateLabel(hovered.href)

  return (
    /* Clipped to the canvas so the card can never spill over the surrounding
       chrome, and transparent to the pointer everywhere except on the card —
       every other event has to reach the drawing surface underneath. */
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <button
        ref={cardRef}
        type="button"
        data-testid="canvas-node-link-card"
        aria-label={t('canvas.link.openTarget', { name })}
        className="pointer-events-auto absolute z-10 flex max-w-[min(20rem,90%)] -translate-x-1/2 translate-y-2 cursor-pointer items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
        // Pixels on the drawing surface's own axes, whose origin is the same
        // corner in either reading direction — geometry, not layout, so a
        // logical inset here would put the card on the wrong side of an RTL
        // canvas.
        style={{ left: hovered.x, top: hovered.y }}
        onClick={() => onOpen(hovered.href)}
      >
        <Link className="size-3.5 shrink-0 text-text-tertiary" />
        <span className="truncate">{name}</span>
      </button>
    </div>
  )
}
