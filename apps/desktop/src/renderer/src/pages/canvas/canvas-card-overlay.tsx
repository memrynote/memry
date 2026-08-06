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

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords,
  CaptureUpdateAction
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { useDndMonitor, useDroppable } from '@dnd-kit/core'
import type { CanvasEntityRef } from '@memry/contracts/canvas-api'
import { toast } from 'sonner'
import { getI18n } from 'react-i18next'
import { Plus } from '@/lib/icons'
import { useTabActions } from '@/contexts/tabs'
import { useOptionalDragContext } from '@/contexts/drag-context'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackTelemetry } from '@/lib/telemetry'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { useT } from '@memry/i18n/renderer'
import { CanvasCard, CARD_SCROLL_ATTR } from './canvas-card'
import { CanvasCardActive } from './canvas-card-active'
import { shouldRenderRich } from './canvas-card-render-mode'
import { wheelScrollDelta } from './canvas-card-scroll'
import { hitTestCard, shouldDeactivateForTool, nextActive, withActivePinned } from './canvas-active'
import { useCanvasEntities, entityKey } from './use-canvas-entities'
import {
  cardDefaultSize,
  computeVisibleCardIds,
  findFreeCardCenter,
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
import {
  CANVAS_DROP_DATA,
  entitiesFromDrag,
  entityFromDndData,
  pointerFromDragEnd
} from './canvas-drop-entity'
import { buildRedirectTab } from './canvas-redirect'
import { noteCardClaims } from './canvas-note-lock'
import { useNoteEditLock, lockReasonForCard } from './use-note-edit-lock'
import { CanvasAddCardDialog } from './canvas-add-card-dialog'
import { onCanvasKeys, revealScroll } from './canvas-add-card'

const log = createLogger('SpatialCanvas')

const ENTER_PADDING = 200
const EXIT_PADDING = 500

/** Stable empty default so the drop handler's deps do not change every render. */
const EMPTY_DRAGGED_TASKS: readonly { id: string }[] = []

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

  // Level of detail: cards render their entity at full editor fidelity until
  // the scene gets too small to read or too crowded to mount (see
  // canvas-card-render-mode.ts). Mirrored in a ref so the imperative recompute
  // only calls setState when the mode actually flips.
  const [rich, setRich] = useState(true)
  const richRef = useRef(true)

  // Bumped whenever a claim attempt fails (canvasNoteClaims is a module
  // singleton, not React state, so another pane's successful claim wouldn't
  // otherwise trigger a re-render here) — included in the `cards` memo deps
  // so this card re-renders locked immediately instead of only on the next
  // unrelated geometry/lockCtx change (design spec §3.3: persistent, not a
  // flash-on-failed-activation badge).
  const [claimFailedTick, setClaimFailedTick] = useState(0)

  const [addOpen, setAddOpen] = useState(false)
  const [addKeys, setAddKeys] = useState<ReadonlySet<string>>(() => new Set<string>())

  const [activeCardId, setActiveCardId] = useState<string | null>(null)
  const activeCardIdRef = useRef<string | null>(null)
  useEffect(() => {
    activeCardIdRef.current = activeCardId
  }, [activeCardId])
  const dispatchActive = useCallback((action: Parameters<typeof nextActive>[1]) => {
    setActiveCardId((prev) => nextActive(prev, action))
  }, [])

  const entities = useCanvasEntities(visibleRefs)
  // Keep entity state reachable from imperative handlers (dblclick redirect).
  const entitiesRef = useRef(entities)
  useEffect(() => {
    entitiesRef.current = entities
  }, [entities])

  const lockCtx = useNoteEditLock()
  // The capture-phase dblclick handler is imperative and is registered once,
  // so it must read the latest lock inputs through a ref, not a closure.
  const lockCtxRef = useRef(lockCtx)
  useEffect(() => {
    lockCtxRef.current = lockCtx
  }, [lockCtx])

  const visibleRefsRef = useRef(visibleRefs)
  useEffect(() => {
    visibleRefsRef.current = visibleRefs
  }, [visibleRefs])

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
    const nextIds = withActivePinned(
      computeVisibleCardIds(cards, rect, {
        enterPadding: ENTER_PADDING,
        exitPadding: EXIT_PADDING,
        previousVisible: visibleIdsRef.current
      }),
      activeCardIdRef.current
    )
    // Active card deleted from the scene, or a non-selection tool chosen → idle.
    const active = activeCardIdRef.current
    if (active) {
      const stillPresent = cards.some((c) => c.elementId === active)
      const toolType = (appState as unknown as { activeTool?: { type?: string } }).activeTool?.type
      if (!stillPresent) {
        dispatchActive({ type: 'cardGone', id: active })
      } else if (toolType && shouldDeactivateForTool(toolType)) {
        dispatchActive({ type: 'deactivate' })
      }
    }
    const visible = cards.filter((card) => nextIds.has(card.elementId))
    const nextRich = shouldRenderRich({
      zoom: appState.zoom.value,
      visibleCount: visible.length
    })
    if (nextRich !== richRef.current) {
      richRef.current = nextRich
      setRich(nextRich)
    }
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
  }, [readScene, dispatchActive])

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

  /**
   * The rectangle a new card should open at. Notes are measured from their own
   * body — a note holding "hey" must not open at the full note frame — which
   * costs one read before the card exists. A failed read falls back to the
   * compact card rather than blocking the placement.
   */
  const resolveCardSize = useCallback(
    async (
      entityType: CanvasCardRef['entityType'],
      entityId: string
    ): Promise<{ width: number; height: number }> => {
      if (entityType !== 'note') {
        return cardDefaultSize(entityType)
      }
      try {
        const note = await notesService.get(entityId)
        return cardDefaultSize('note', note?.content ?? '')
      } catch (err) {
        log.error('Failed to size canvas note card', { entityId, error: err })
        return cardDefaultSize('note')
      }
    },
    []
  )

  /**
   * Cards for one or more entities in a single scene update. The first lands
   * exactly on (centerX, centerY) — the user picked that point by dropping
   * there — and each further card spirals out to the nearest free cell so a
   * multi-select drop tiles instead of stacking into one unreadable pile.
   * Per-ref `sizes` (from resolveCardSize) let a note open sized to its own
   * body; a ref with no size falls back to its type's default frame, which is
   * also what non-note refs always get.
   */
  const createCardElements = useCallback(
    (
      refs: readonly CanvasEntityRef[],
      centerX: number,
      centerY: number,
      sizes?: ReadonlyArray<{ width: number; height: number } | undefined>
    ): void => {
      if (refs.length === 0) {
        return
      }
      const existing = excalidrawAPI.getSceneElementsIncludingDeleted()
      // Occupancy grows as we place, so cards in the same drop avoid each other
      // and not just the cards that were already on the scene.
      const occupied = getCardRefs(existing as unknown as CardElement[])
      const skeletons = refs.map((ref, index) => {
        const size = sizes?.[index] ?? cardDefaultSize(ref.entityType)
        const center =
          index === 0
            ? { x: centerX, y: centerY }
            : findFreeCardCenter(occupied, {
                minX: centerX,
                maxX: centerX,
                minY: centerY,
                maxY: centerY
              })
        occupied.push({
          elementId: '',
          entityType: ref.entityType,
          entityId: ref.entityId,
          x: center.x - size.width / 2,
          y: center.y - size.height / 2,
          width: size.width,
          height: size.height,
          angle: 0
        })
        return makeCardSkeleton({
          entityType: ref.entityType,
          entityId: ref.entityId,
          centerX: center.x,
          centerY: center.y,
          width: size.width,
          height: size.height
        })
      })
      const created = convertToExcalidrawElements(
        skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
      )
      excalidrawAPI.updateScene({
        elements: [...existing, ...created],
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      // Every UI placement path (add-card picker, dnd drop, HTML5 drop,
      // create-note) funnels through here, so this is the one choke point for
      // the created → opened → carded funnel.
      for (const ref of refs) {
        void trackTelemetry('canvas_card_added', {
          surface: 'canvas',
          action: 'added',
          objectType: ref.entityType,
          result: 'success'
        })
      }
      onSceneMutated()
      recompute()
    },
    [excalidrawAPI, onSceneMutated, recompute]
  )

  const createCardElement = useCallback(
    (
      entityType: CanvasCardRef['entityType'],
      entityId: string,
      centerX: number,
      centerY: number,
      size: { width: number; height: number }
    ): void => {
      createCardElements([{ entityType, entityId }], centerX, centerY, [size])
    },
    [createCardElements]
  )

  // The dnd-kit drop target, alongside the capture-phase HTML5 one below.
  // Task rows and calendar chips spread their dnd-kit listeners on the row
  // root, so they cannot also carry a native `draggable` without two drag
  // systems racing on one pointerdown — they arrive through dnd-kit instead.
  // useId keys the target to this mounted layer, so two canvases open in a
  // split view are two independent drop targets with no central registry.
  const dropId = useId()
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropId, data: CANVAS_DROP_DATA })
  useEffect(() => {
    setDropRef(wrapperRef.current)
    return () => setDropRef(null)
  }, [setDropRef, wrapperRef])

  // Optional: the canvas renders inside DragProvider in the app, but must not
  // require it (tests mount the layer alone). Without it, a multi-select drop
  // degrades to placing the one dragged row.
  const dragContext = useOptionalDragContext()
  const draggedTasks = dragContext?.dragState.draggedTasks ?? EMPTY_DRAGGED_TASKS
  const [dragPlaceable, setDragPlaceable] = useState(false)

  useDndMonitor({
    onDragStart: (event) => {
      setDragPlaceable(
        entityFromDndData(event.active.data.current, String(event.active.id)) !== null
      )
    },
    onDragCancel: () => setDragPlaceable(false),
    onDragEnd: (event) => {
      setDragPlaceable(false)
      if (event.over?.id !== dropId) {
        return
      }
      const refs = entitiesFromDrag(
        event.active.data.current,
        String(event.active.id),
        draggedTasks
      )
      if (refs.length === 0) {
        return
      }
      const pointer = pointerFromDragEnd(event.activatorEvent, event.delta)
      if (!pointer) {
        // Keyboard sensor: there is no pointer to drop on, so fall back to the
        // automatic placement the Add-card picker uses.
        const { cards, appState } = readScene()
        const rect = viewportSceneRect(appState, {
          width: clipRef.current?.clientWidth ?? 0,
          height: clipRef.current?.clientHeight ?? 0
        })
        const { x, y } = findFreeCardCenter(cards, rect)
        createCardElements(refs, x, y)
        return
      }
      const scene = viewportCoordsToSceneCoords(pointer, excalidrawAPI.getAppState())
      createCardElements(refs, scene.x, scene.y)
    }
  })

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
      // The size read is async, but the drop point is not — capture it here.
      void resolveCardSize(item.entityType, item.entityId).then((size) => {
        createCardElement(item.entityType, item.entityId, scene.x, scene.y, size)
      })
    }

    // dblclick activates the hit card (↗ redirect stays the only way to open a
    // tab — skip when the dblclick landed on that button, matrix #20).
    const onDblClick = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest('[data-canvas-redirect]')) {
        return
      }
      const appState = excalidrawAPI.getAppState()
      const scene = viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        appState
      )
      const cards = getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[])
      const hit = hitTestCard(cards, scene)
      if (hit) {
        e.preventDefault()
        e.stopPropagation()
        // Unauthenticated + the note already live elsewhere => stay read-only.
        // Two non-collaborative editors on one note clobber each other and both
        // run ContentArea's task auto-conversion (M6 design §12/6).
        if (lockReasonForCard(lockCtxRef.current, hit)) {
          return
        }
        // Claim synchronously here, not in the effect below, so two panes racing
        // on the same note cannot both pass the gate in one tick. The effect
        // re-claims idempotently and owns the release.
        if (hit.entityType === 'note' && !noteCardClaims.claim(hit.entityId, hit.elementId)) {
          setClaimFailedTick((n) => n + 1)
          return
        }
        dispatchActive({ type: 'activate', id: hit.elementId })
      }
    }

    // An idle card is pointer-events:none, so it never receives a wheel event of
    // its own: the layer hit-tests the card under the cursor and scrolls it
    // imperatively. The event is only consumed when that scroll actually moves
    // (canvas-card-scroll.ts), so a short card — or one already at its edge —
    // still zooms the canvas. The active card scrolls natively; Cmd/Ctrl+wheel
    // is always Excalidraw's zoom.
    const onWheel = (e: WheelEvent): void => {
      if (e.ctrlKey || e.metaKey) {
        return
      }
      const appState = excalidrawAPI.getAppState()
      const scene = viewportCoordsToSceneCoords(
        { clientX: e.clientX, clientY: e.clientY },
        appState
      )
      const cards = getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[])
      const hit = hitTestCard(cards, scene)
      if (!hit || hit.elementId === activeCardIdRef.current) {
        return
      }
      const scroller = layerRef.current?.querySelector<HTMLElement>(
        `[${CARD_SCROLL_ATTR}="${hit.elementId}"]`
      )
      if (!scroller) {
        return
      }
      const applied = wheelScrollDelta(
        {
          scrollTop: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight
        },
        e.deltaY,
        appState.zoom.value
      )
      if (applied === 0) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      scroller.scrollTop += applied
    }

    // Click-away deactivates the active card. Never stopPropagation here — the
    // same pointerdown must still pan/select/draw on the canvas (C4).
    const onPointerDownAway = (e: PointerEvent): void => {
      const active = activeCardIdRef.current
      if (!active) {
        return
      }
      const target = e.target as Element | null
      if (!target?.closest(`[data-canvas-active-card="${active}"]`)) {
        dispatchActive({ type: 'deactivate' })
      }
    }

    wrapper.addEventListener('dragover', onDragOver, { capture: true })
    wrapper.addEventListener('drop', onDrop, { capture: true })
    wrapper.addEventListener('dblclick', onDblClick, { capture: true })
    wrapper.addEventListener('pointerdown', onPointerDownAway, { capture: true })
    // Non-passive: consuming the gesture requires preventDefault().
    wrapper.addEventListener('wheel', onWheel, { capture: true, passive: false })
    return () => {
      wrapper.removeEventListener('dragover', onDragOver, { capture: true })
      wrapper.removeEventListener('drop', onDrop, { capture: true })
      wrapper.removeEventListener('dblclick', onDblClick, { capture: true })
      wrapper.removeEventListener('pointerdown', onPointerDownAway, { capture: true })
      wrapper.removeEventListener('wheel', onWheel, { capture: true })
    }
  }, [
    wrapperRef,
    excalidrawAPI,
    createCardElement,
    resolveCardSize,
    dispatchActive,
    setClaimFailedTick
  ])

  // Release the claim when the card deactivates or the layer unmounts. Keyed on
  // activeCardId only: visibleRefs changes on every geometry tick, and keying on
  // it would churn claim/release during a drag.
  useEffect(() => {
    if (!activeCardId) return
    const card = visibleRefsRef.current.find((c) => c.elementId === activeCardId)
    if (!card || card.entityType !== 'note') return
    const noteId = card.entityId
    noteCardClaims.claim(noteId, activeCardId)
    return () => noteCardClaims.release(noteId, activeCardId)
  }, [activeCardId])

  // A note tab becoming visible in another pane while a card is active would
  // reopen the clobber window, so the card yields immediately. EmbeddedNoteEditor
  // flushes its pending save on unmount (embedded-note-editor.tsx), but that
  // flush is fire-and-forget (`void flush()`) and races the newly-opened tab's
  // own fetch — a sub-second window that only loses text if the user types
  // into the tab before the flush lands. Pre-existing, shared with the ↗
  // redirect path; not introduced by this guard.
  // Reacts to an external context change (the note becoming locked elsewhere
  // via useNoteEditLock), not a user action on this component — there is no
  // event handler to move this into.
  /* eslint-disable react-you-might-not-need-an-effect/no-event-handler */
  useEffect(() => {
    const active = activeCardIdRef.current
    if (!active) return
    const card = visibleRefsRef.current.find((c) => c.elementId === active)
    if (card && lockReasonForCard(lockCtx, card)) {
      dispatchActive({ type: 'deactivate' })
    }
  }, [lockCtx, dispatchActive])
  /* eslint-enable react-you-might-not-need-an-effect/no-event-handler */

  const placeCard = useCallback(
    async (entityType: CanvasCardRef['entityType'], entityId: string) => {
      const size = await resolveCardSize(entityType, entityId)
      // Read the scene AFTER the size await, so a card added meanwhile counts.
      const { cards, appState } = readScene()
      const rect = viewportSceneRect(appState, {
        width: clipRef.current?.clientWidth ?? 0,
        height: clipRef.current?.clientHeight ?? 0
      })
      // Free cell, not the raw centre: repeated picks would otherwise pile up
      // on one point and have to be dragged apart (#871). The spiral steps by
      // the size this card will actually get, so note cards clear each other.
      const { x, y } = findFreeCardCenter(cards, rect, size)
      createCardElement(entityType, entityId, x, y, size)
    },
    [readScene, createCardElement, resolveCardSize]
  )

  const handleCreateNote = useCallback(
    async (title: string) => {
      try {
        const result = await notesService.create({ title: title || 'Untitled Note', content: '' })
        if (!result.success || !result.note) {
          throw new Error(result.error ?? 'note create failed')
        }
        await placeCard('note', result.note.id)
      } catch (err) {
        log.error('Failed to create canvas note', err)
        trackRendererError('canvas_create_note', err)
        toast.error(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'common')('canvas.card.createNoteFailed')
          )
        )
      }
    },
    [placeCard]
  )

  // Picking an entity that already has a card centers that card instead of
  // adding a second one, so entity refs stay 1:1 and arrows never fragment.
  const handleReveal = useCallback(
    (entityType: CanvasCardRef['entityType'], entityId: string) => {
      const { cards, appState } = readScene()
      const card = cards.find((c) => c.entityType === entityType && c.entityId === entityId)
      if (!card) {
        return
      }
      const { scrollX, scrollY } = revealScroll(
        card,
        {
          width: clipRef.current?.clientWidth ?? 0,
          height: clipRef.current?.clientHeight ?? 0
        },
        appState.zoom.value
      )
      excalidrawAPI.updateScene({
        appState: { scrollX, scrollY, selectedElementIds: { [card.elementId]: true } },
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      recompute()
    },
    [readScene, excalidrawAPI, recompute]
  )

  // Snapshot the carded entities when the picker opens. A useMemo keyed on
  // `addOpen` would read the scene on every render and trip exhaustive-deps
  // (addOpen is not referenced in the computation).
  const openAddDialog = useCallback(() => {
    setAddKeys(
      onCanvasKeys(getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[]))
    )
    setAddOpen(true)
  }, [excalidrawAPI])

  const cards = useMemo(() => {
    // Referenced (no-op) purely so this memo re-evaluates after a failed
    // cross-pane claim — see the claimFailedTick declaration above.
    void claimFailedTick
    return visibleRefs.map((card) => {
      const isActive = card.elementId === activeCardId
      const locked = isActive ? null : lockReasonForCard(lockCtx, card)
      return (
        <div
          key={card.elementId}
          className="absolute"
          style={{
            left: card.x,
            top: card.y,
            width: card.width,
            height: card.height,
            transform: card.angle ? `rotate(${card.angle}rad)` : undefined,
            transformOrigin: 'center',
            pointerEvents: isActive ? 'auto' : undefined
          }}
        >
          {isActive ? (
            <CanvasCardActive
              cardRef={card}
              state={entities.get(entityKey(card.entityType, card.entityId))}
              onDeactivate={() => dispatchActive({ type: 'deactivate' })}
            />
          ) : (
            <CanvasCard
              cardRef={card}
              state={entities.get(entityKey(card.entityType, card.entityId))}
              onRedirect={redirect}
              rich={rich}
              locked={locked}
            />
          )}
        </div>
      )
    })
  }, [
    visibleRefs,
    entities,
    redirect,
    activeCardId,
    dispatchActive,
    lockCtx,
    claimFailedTick,
    rich
  ])

  return (
    <>
      {/* Drop affordance: only while a canvas-placeable drag is over this
          canvas, so hovering it with a task being reordered stays silent. */}
      {isOver && dragPlaceable ? (
        <div
          data-testid="canvas-drop-ring"
          aria-hidden="true"
          className="pointer-events-none absolute inset-2 z-[4] rounded-lg border-2 border-dashed border-sidebar-terracotta/60"
        />
      ) : null}
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
        onClick={openAddDialog}
        data-testid="canvas-add-card"
        // Horizontally centered (symmetric in RTL) via inline left/translate.
        style={{ left: '50%', transform: 'translateX(-50%)' }}
        className="pointer-events-auto absolute bottom-4 z-10 flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-text-secondary shadow-sm transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" aria-hidden="true" />
        {t('canvas.card.addCard')}
      </button>
      <CanvasAddCardDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCanvasKeys={addKeys}
        onCreateNote={(title) => void handleCreateNote(title)}
        onPick={(entityType, entityId) => void placeCard(entityType, entityId)}
        onReveal={handleReveal}
      />
    </>
  )
}
