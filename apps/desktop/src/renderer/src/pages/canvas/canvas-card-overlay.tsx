/**
 * CanvasCardLayer — the DOM overlay that renders read-only preview cards over
 * the Excalidraw scene and owns all card behavior (drop-to-create, capture a
 * new note, ↗ redirect, dblclick redirect).
 *
 * Perf model (M2): the layer transform is applied IMPERATIVELY on every
 * onChange (zero setState during pan); only a change in the set OR geometry of
 * visible cards triggers a React render, and only cards inside a padded
 * viewport are mounted (virtualization with hysteresis).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
  CaptureUpdateAction
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { Plus } from '@/lib/icons'
import { useTabActions } from '@/contexts/tabs'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import { CanvasCard } from './canvas-card'
import { useCanvasEntities, entityKey } from './use-canvas-entities'
import {
  computeVisibleCardIds,
  getCardRefs,
  makeCardSkeleton,
  overlayTransform,
  readCanvasDragItem,
  sameMembership,
  viewportSceneRect,
  CANVAS_ITEM_DRAG_MIME,
  type CanvasAppStateView,
  type CanvasCardRef,
  type CardElement
} from './canvas-cards'
import { buildRedirectTab } from './canvas-redirect'

const log = createLogger('SpatialCanvas')

const ENTER_PADDING = 200
const EXIT_PADDING = 500

interface CanvasCardLayerProps {
  excalidrawAPI: ExcalidrawImperativeAPI
  /** Wrapper element hosting the canvas — capture-phase drop/dblclick attach here. */
  wrapperRef: React.RefObject<HTMLDivElement | null>
  /** Notifies the scene persister after a card is created. */
  onSceneMutated: () => void
}

export const CanvasCardLayer = ({
  excalidrawAPI,
  wrapperRef,
  onSceneMutated
}: CanvasCardLayerProps): React.JSX.Element => {
  const { t } = useT('common')
  const { openTab } = useTabActions()
  const layerRef = useRef<HTMLDivElement>(null)
  const clipRef = useRef<HTMLDivElement>(null)

  const [visibleRefs, setVisibleRefs] = useState<CanvasCardRef[]>([])
  const visibleIdsRef = useRef<Set<string>>(new Set())
  const signatureRef = useRef('')

  const entities = useCanvasEntities(visibleRefs)
  // Keep entity state reachable from imperative handlers (dblclick redirect).
  const entitiesRef = useRef(entities)
  useEffect(() => {
    entitiesRef.current = entities
  }, [entities])

  const readScene = useCallback((): {
    cards: CanvasCardRef[]
    appState: CanvasAppStateView & { offsetLeft: number; offsetTop: number }
  } => {
    const elements = excalidrawAPI.getSceneElements() as unknown as CardElement[]
    const appState = excalidrawAPI.getAppState() as unknown as CanvasAppStateView & {
      offsetLeft: number
      offsetTop: number
    }
    return { cards: getCardRefs(elements), appState }
  }, [excalidrawAPI])

  const recompute = useCallback(() => {
    const { cards, appState } = readScene()
    const clip = clipRef.current
    const layer = layerRef.current
    if (!clip || !layer) {
      return
    }
    // Transform is imperative: no React render during pan/zoom.
    layer.style.transform = overlayTransform(appState)
    clip.dataset.scrollX = String(appState.scrollX)
    clip.dataset.scrollY = String(appState.scrollY)
    clip.dataset.zoom = String(appState.zoom.value)

    const rect = viewportSceneRect(appState, {
      width: clip.clientWidth,
      height: clip.clientHeight
    })
    const nextIds = computeVisibleCardIds(cards, rect, {
      enterPadding: ENTER_PADDING,
      exitPadding: EXIT_PADDING,
      previousVisible: visibleIdsRef.current
    })
    const visible = cards.filter((card) => nextIds.has(card.elementId))
    // Re-render on membership OR geometry change (a moved card), never on pan.
    const signature = visible
      .map(
        (c) =>
          `${c.elementId}:${Math.round(c.x)}:${Math.round(c.y)}:${Math.round(c.width)}:${Math.round(c.height)}:${c.angle.toFixed(3)}`
      )
      .join('|')
    const membershipChanged = !sameMembership(nextIds, visibleIdsRef.current)
    visibleIdsRef.current = nextIds
    if (membershipChanged || signature !== signatureRef.current) {
      signatureRef.current = signature
      setVisibleRefs(visible)
    }
  }, [readScene])

  useEffect(() => {
    recompute()
    const unsubscribe = excalidrawAPI.onChange(() => recompute())
    return unsubscribe
  }, [excalidrawAPI, recompute])

  // Container resize changes the viewport → recompute membership + let
  // Excalidraw recalc its canvas offsets so coordinate math stays correct.
  useEffect(() => {
    const clip = clipRef.current
    if (!clip || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      excalidrawAPI.refresh()
      recompute()
    })
    observer.observe(clip)
    return () => observer.disconnect()
  }, [excalidrawAPI, recompute])

  const redirect = useCallback(
    (card: CanvasCardRef): void => {
      const state = entitiesRef.current.get(entityKey(card.entityType, card.entityId))
      const tab = buildRedirectTab({
        entityType: card.entityType,
        entityId: card.entityId,
        title: state?.status === 'ready' && state.kind === 'note' ? state.title : '',
        startAt:
          state?.status === 'ready' && state.kind === 'calendar_event' ? state.startAt : null,
        now: Date.now()
      })
      if (tab) {
        openTab(tab)
      }
    },
    [openTab]
  )

  const createCardElement = useCallback(
    (
      entityType: CanvasCardRef['entityType'],
      entityId: string,
      centerX: number,
      centerY: number
    ): void => {
      const skeleton = makeCardSkeleton({ entityType, entityId, centerX, centerY })
      const created = convertToExcalidrawElements([skeleton] as unknown as Parameters<
        typeof convertToExcalidrawElements
      >[0])
      const existing = excalidrawAPI.getSceneElementsIncludingDeleted()
      excalidrawAPI.updateScene({
        elements: [...existing, ...created],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      onSceneMutated()
      recompute()
    },
    [excalidrawAPI, onSceneMutated, recompute]
  )

  // Capture-phase drop/dragover/dblclick on the wrapper so they run before
  // Excalidraw's own handlers (mirrors the note editor's capture listeners).
  useEffect(() => {
    const wrapper = wrapperRef.current
    if (!wrapper) {
      return
    }

    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes(CANVAS_ITEM_DRAG_MIME)) {
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      }
    }

    const onDrop = (e: DragEvent): void => {
      if (!e.dataTransfer) {
        return
      }
      const item = readCanvasDragItem((type) => e.dataTransfer!.getData(type))
      if (!item) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const appState = excalidrawAPI.getAppState()
      const scene = viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        appState
      )
      createCardElement(item.entityType, item.entityId, scene.x, scene.y)
    }

    const onDblClick = (e: MouseEvent): void => {
      const appState = excalidrawAPI.getAppState()
      const scene = viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        appState
      )
      const cards = getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[])
      // Reverse z-order: last element is topmost.
      for (let i = cards.length - 1; i >= 0; i--) {
        const card = cards[i]
        if (
          scene.x >= card.x &&
          scene.x <= card.x + card.width &&
          scene.y >= card.y &&
          scene.y <= card.y + card.height
        ) {
          e.preventDefault()
          e.stopPropagation()
          redirect(card)
          return
        }
      }
    }

    wrapper.addEventListener('dragover', onDragOver, { capture: true })
    wrapper.addEventListener('drop', onDrop, { capture: true })
    wrapper.addEventListener('dblclick', onDblClick, { capture: true })
    return () => {
      wrapper.removeEventListener('dragover', onDragOver, { capture: true })
      wrapper.removeEventListener('drop', onDrop, { capture: true })
      wrapper.removeEventListener('dblclick', onDblClick, { capture: true })
    }
  }, [wrapperRef, excalidrawAPI, createCardElement, redirect])

  const handleCreateNote = useCallback(async () => {
    try {
      const result = await notesService.create({ title: 'Untitled Note', content: '' })
      if (!result.success || !result.note) {
        throw new Error(result.error ?? 'note create failed')
      }
      const { appState } = readScene()
      const rect = viewportSceneRect(appState, {
        width: clipRef.current?.clientWidth ?? 0,
        height: clipRef.current?.clientHeight ?? 0
      })
      createCardElement(
        'note',
        result.note.id,
        (rect.minX + rect.maxX) / 2,
        (rect.minY + rect.maxY) / 2
      )
    } catch (err) {
      log.error('Failed to create canvas note', err)
      toast.error(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'common')('canvas.card.createNoteFailed')
        )
      )
    }
  }, [readScene, createCardElement])

  const cards = useMemo(
    () =>
      visibleRefs.map((card) => (
        <div
          key={card.elementId}
          className="absolute"
          style={{
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
            transform: card.angle ? `rotate(${card.angle}rad)` : undefined,
            transformOrigin: 'center'
          }}
        >
          <CanvasCard
            cardRef={card}
            state={entities.get(entityKey(card.entityType, card.entityId))}
            onRedirect={redirect}
          />
        </div>
      )),
    [visibleRefs, entities, redirect]
  )

  return (
    <>
      {/* z-[3] lifts the overlay above Excalidraw's interactive canvas
          (--zIndex-interactiveCanvas: 2) so card previews cover their
          rectangles and the ↗ buttons are clickable. .excalidraw has no
          z-index, so its canvases share this stacking context. The layer is
          pointer-events:none, so pan/draw still pass through to the canvas;
          Excalidraw's toolbar/panels (z-index 4+) stay above the overlay. */}
      <div ref={clipRef} className="pointer-events-none absolute inset-0 z-[3] overflow-hidden">
        {/* Positioned at the scene origin (0,0) with transform-origin 0 0 —
            coordinate space, RTL-invariant, so inline (not logical classes). */}
        <div
          ref={layerRef}
          data-canvas-overlay=""
          className="absolute will-change-transform"
          style={{ left: 0, top: 0, transformOrigin: '0 0' }}
        >
          {cards}
        </div>
      </div>
      <button
        type="button"
        onClick={() => void handleCreateNote()}
        data-testid="canvas-new-note"
        // Horizontally centered (symmetric in RTL) via inline left/translate.
        style={{ left: '50%', transform: 'translateX(-50%)' }}
        className="pointer-events-auto absolute bottom-4 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t('canvas.card.newNote')}
      </button>
    </>
  )
}
