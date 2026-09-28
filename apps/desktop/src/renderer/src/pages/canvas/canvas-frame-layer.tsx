/**
 * CanvasFrameLayer — frames bound to a category (#2483).
 *
 * Watches card membership in frames and turns it into metadata:
 *
 *  - A card that lands in a bound frame (dragged in, dropped in from the
 *    sidebar, pasted in) gets the frame's tag or property value, with a toast
 *    whose Undo puts the card back and reverts the write.
 *  - A card dragged OUT of a bound frame keeps its category. The toast offers
 *    to remove it: a drag must never silently strip data.
 *  - Excalidraw's own undo (Cmd/Ctrl+Z, the undo button) of a drop reverts the
 *    write that drop made, so undo means the same thing on both halves.
 *
 * It also draws the chip over each bound frame (binding + card count), the
 * "Categorize" chip on a selected unbound frame, and runs "Lay out by
 * property".
 *
 * Membership is read from Excalidraw's `frameId`, which Excalidraw only
 * assigns when a drag ends, so a card passing over a frame mid-drag changes
 * nothing.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { convertToExcalidrawElements, CaptureUpdateAction } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { Hash, Tag } from '@/lib/icons'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { propertiesService } from '@/services/properties-service'
import { entityKey, getCardRefs, viewportSceneRect, type CanvasAppStateView } from './canvas-cards'
import {
  bindingLabel,
  bumpElement,
  cardMembership,
  categorizeSkipReason,
  diffMembership,
  getFrameBindings,
  getFrames,
  hasPropertyValue,
  layoutOrigin,
  placeInFrame,
  planPropertyLayout,
  readFrameBinding,
  sameBinding,
  withFrameBinding,
  type CardPlacement,
  type CategorizeSkipReason,
  type FrameBinding,
  type FrameSceneElement,
  type FrameView,
  type MembershipChange
} from './canvas-frame-binding'
import {
  applyFrameBinding,
  removeFrameBinding,
  type CategorizeTarget
} from './canvas-frame-categorize'
import { CanvasFrameBindingDialog } from './canvas-frame-binding-dialog'
import { CanvasFrameLayoutDialog } from './canvas-frame-layout-dialog'
import type { BindableProperty } from './use-frame-binding-choices'

const log = createLogger('SpatialCanvas')

/** A membership change this soon after an undo/redo gesture is that gesture's doing. */
const HISTORY_WINDOW_MS = 1000
/** Enough to undo the recent drops; older ones age out. */
const MAX_APPLIED_RECORDS = 200
const TOAST_DURATION_MS = 8000

/** A write this layer made because a card entered a bound frame. */
interface AppliedRecord {
  elementId: string
  frameId: string
  /** Where the card came from, so Undo can put it back; null = it was new. */
  fromFrameId: string | null
  before: { x: number; y: number } | null
  revert: () => Promise<void>
}

type AppState = CanvasAppStateView & {
  isLoading?: boolean
  selectedElementIds?: Readonly<Record<string, boolean>>
}

interface CanvasFrameLayerProps {
  excalidrawAPI: ExcalidrawImperativeAPI
  /** False in view mode: chips still show, but nothing is written. */
  editable: boolean
  /** Notifies the scene persister after this layer changes the scene. */
  onSceneMutated: () => void
  layoutOpen: boolean
  onLayoutOpenChange: (open: boolean) => void
}

function targetOf(change: CategorizeTarget): CategorizeTarget {
  return { entityType: change.entityType, entityId: change.entityId }
}

export const CanvasFrameLayer = ({
  excalidrawAPI,
  editable,
  onSceneMutated,
  layoutOpen,
  onLayoutOpenChange
}: CanvasFrameLayerProps): React.JSX.Element => {
  const { t } = useT('common')
  const [frames, setFrames] = useState<FrameView[]>([])
  const [selectedFrameId, setSelectedFrameId] = useState<string | null>(null)
  const [bindingFrameId, setBindingFrameId] = useState<string | null>(null)

  const layerRef = useRef<HTMLDivElement>(null)
  const framesRef = useRef<FrameView[]>([])
  const framesSignatureRef = useRef('')
  const baselineRef = useRef<Map<string, CardPlacement> | null>(null)
  const lastElementsRef = useRef<unknown>(null)
  const historyAtRef = useRef(0)
  const appliedRef = useRef(new Map<string, AppliedRecord>())
  const frameRequestRef = useRef<number | null>(null)
  const editableRef = useRef(editable)
  const onSceneMutatedRef = useRef(onSceneMutated)
  const tRef = useRef(t)
  useEffect(() => {
    editableRef.current = editable
    onSceneMutatedRef.current = onSceneMutated
    tRef.current = t
  }, [editable, onSceneMutated, t])

  const sceneElements = useCallback(
    (): FrameSceneElement[] =>
      excalidrawAPI.getSceneElementsIncludingDeleted() as unknown as FrameSceneElement[],
    [excalidrawAPI]
  )

  const rebaseline = useCallback((): void => {
    const elements = excalidrawAPI.getSceneElementsIncludingDeleted()
    lastElementsRef.current = elements
    baselineRef.current = cardMembership(elements as unknown as FrameSceneElement[])
  }, [excalidrawAPI])

  const replaceScene = useCallback(
    (elements: readonly FrameSceneElement[]): void => {
      excalidrawAPI.updateScene({
        elements: elements as never,
        captureUpdate: CaptureUpdateAction.IMMEDIATELY
      })
      // Our own edit is not a user drop: re-read membership before the change
      // listener can diff it.
      rebaseline()
      onSceneMutatedRef.current()
    },
    [excalidrawAPI, rebaseline]
  )

  const remember = useCallback((record: AppliedRecord): void => {
    const applied = appliedRef.current
    applied.delete(record.elementId)
    applied.set(record.elementId, record)
    if (applied.size > MAX_APPLIED_RECORDS) {
      const oldest = applied.keys().next().value
      if (oldest !== undefined) applied.delete(oldest)
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Chips: positioned imperatively on every commit, rendered only when the set
  // of frames, their bindings, counts or geometry change.
  // ---------------------------------------------------------------------------

  /** Scene → viewport, the same mapping the card overlay applies. */
  const chipTransform = useCallback(
    (frame: FrameView): string => {
      const appState = excalidrawAPI.getAppState() as unknown as AppState
      const zoom = appState.zoom.value
      // Physical coordinates: this is scene space, not layout.
      const left = (frame.x + frame.width + appState.scrollX) * zoom
      const top = (frame.y + appState.scrollY) * zoom
      return `translate(${left}px, ${top}px) translate(-100%, calc(-100% - 6px))`
    },
    [excalidrawAPI]
  )

  const positionChips = useCallback((): void => {
    const layer = layerRef.current
    if (!layer) return
    const byId = new Map(framesRef.current.map((frame) => [frame.id, frame]))
    for (const chip of layer.querySelectorAll<HTMLElement>('[data-canvas-frame-chip]')) {
      const frame = byId.get(chip.dataset.canvasFrameChip ?? '')
      if (frame) chip.style.transform = chipTransform(frame)
    }
  }, [chipTransform])

  const refreshFrames = useCallback(
    (elements: readonly FrameSceneElement[], appState: AppState): void => {
      const next = getFrames(elements)
      const selected = Object.entries(appState.selectedElementIds ?? {})
        .filter(([, on]) => on)
        .map(([id]) => id)
      const selectedFrame =
        selected.length === 1 && next.some((frame) => frame.id === selected[0]) ? selected[0] : null
      const signature = `${selectedFrame ?? ''}|${next
        .map(
          (f) =>
            `${f.id}:${Math.round(f.x)}:${Math.round(f.y)}:${Math.round(f.width)}:${Math.round(f.height)}:${f.cardCount}:${f.binding ? bindingLabel(f.binding) : ''}`
        )
        .join('|')}`
      framesRef.current = next
      if (signature !== framesSignatureRef.current) {
        framesSignatureRef.current = signature
        setFrames(next)
        setSelectedFrameId(selectedFrame)
      }
    },
    []
  )

  // ---------------------------------------------------------------------------
  // Categorizing
  // ---------------------------------------------------------------------------

  const skipMessage = useCallback((reason: CategorizeSkipReason, count: number): string => {
    const tr = tRef.current
    if (reason === 'file') return tr('canvas.frame.skippedFile', { count })
    if (reason === 'taskProperty') return tr('canvas.frame.skippedTaskProperty', { count })
    return tr('canvas.frame.skippedUnsupported', { count })
  }, [])

  const undoEntered = useCallback(
    async (records: readonly AppliedRecord[], label: string): Promise<void> => {
      const tr = tRef.current
      const byElement = new Map(records.map((record) => [record.elementId, record]))
      let moved = false
      const next = sceneElements().map((element) => {
        const record = byElement.get(element.id)
        // Only a card still where the drop left it goes back; one the user has
        // moved on since is theirs now.
        if (!record || element.isDeleted || element.frameId !== record.frameId) return element
        moved = true
        if (!record.before) return bumpElement(element, { isDeleted: true })
        return bumpElement(element, {
          x: record.before.x,
          y: record.before.y,
          frameId: record.fromFrameId
        })
      })
      if (moved) replaceScene(next)
      for (const record of records) {
        if (appliedRef.current.get(record.elementId) === record) {
          appliedRef.current.delete(record.elementId)
        }
      }
      const results = await Promise.allSettled(records.map((record) => record.revert()))
      const failed = results.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      if (failed) {
        log.error('Failed to revert frame categorization', failed.reason)
        trackRendererError('canvas_frame_revert', failed.reason)
        toast.error(extractErrorMessage(failed.reason, tr('canvas.frame.revertFailed', { label })))
      }
    },
    [replaceScene, sceneElements]
  )

  /**
   * Applies `binding` to every card in `changes`, one toast for the batch.
   * `move` says whether Undo should also put the cards back (a drop) or only
   * revert the writes (binding a frame that already held cards).
   */
  const categorize = useCallback(
    async (
      frameId: string,
      binding: FrameBinding,
      changes: readonly MembershipChange[],
      move: boolean
    ): Promise<void> => {
      const tr = tRef.current
      const label = bindingLabel(binding)
      const records: AppliedRecord[] = []
      const skipped = new Map<CategorizeSkipReason, number>()
      let firstError: unknown = null
      // Two cards for the same entity are one write.
      const seen = new Set<string>()

      for (const change of changes) {
        const key = entityKey(change.entityType, change.entityId)
        if (seen.has(key)) continue
        seen.add(key)
        try {
          const outcome = await applyFrameBinding(targetOf(change), binding)
          if (outcome.status === 'skipped') {
            skipped.set(outcome.reason, (skipped.get(outcome.reason) ?? 0) + 1)
          } else if (outcome.status === 'applied') {
            const record: AppliedRecord = {
              elementId: change.elementId,
              frameId,
              fromFrameId: change.fromFrameId,
              before: change.before,
              revert: outcome.revert
            }
            records.push(record)
            // Only a drop is something Excalidraw's undo can take back.
            if (move) remember(record)
          }
        } catch (err) {
          firstError ??= err
          log.error('Failed to categorize canvas card', { entityId: change.entityId, error: err })
        }
      }

      if (firstError) {
        trackRendererError('canvas_frame_categorize', firstError)
        toast.error(extractErrorMessage(firstError, tr('canvas.frame.applyFailed', { label })))
      }
      for (const [reason, count] of skipped) {
        toast(skipMessage(reason, count))
      }
      if (records.length === 0) return

      toast.success(tr('canvas.frame.applied', { count: records.length, label }), {
        duration: TOAST_DURATION_MS,
        action: {
          label: tr('action.undo'),
          onClick: () => {
            if (move) {
              void undoEntered(records, label)
              return
            }
            // Binding a frame over cards that were already inside: revert the
            // writes only. The cards stay where they are.
            void Promise.allSettled(records.map((record) => record.revert()))
          }
        }
      })
    },
    [remember, skipMessage, undoEntered]
  )

  const offerRemoval = useCallback(
    (binding: FrameBinding, changes: readonly MembershipChange[]): void => {
      const tr = tRef.current
      const label = bindingLabel(binding)
      const targets = changes.filter(
        (change) => categorizeSkipReason(change.entityType, binding) === null
      )
      if (targets.length === 0) return
      toast(tr('canvas.frame.leftFrame', { count: targets.length, label }), {
        duration: TOAST_DURATION_MS,
        action: {
          label: tr('canvas.frame.removeCategory', { label }),
          onClick: () => {
            void (async () => {
              let removed = 0
              try {
                for (const change of targets) {
                  const outcome = await removeFrameBinding(targetOf(change), binding)
                  if (outcome.status === 'applied') removed += 1
                }
                if (removed > 0) {
                  toast.success(tr('canvas.frame.removed', { count: removed, label }))
                }
              } catch (err) {
                log.error('Failed to remove frame category', err)
                trackRendererError('canvas_frame_remove', err)
                toast.error(extractErrorMessage(err, tr('canvas.frame.removeFailed', { label })))
              }
            })()
          }
        }
      })
    },
    []
  )

  const handleChanges = useCallback(
    (changes: readonly MembershipChange[], elements: readonly FrameSceneElement[]): void => {
      const bindings = getFrameBindings(elements)
      const historyStep = Date.now() - historyAtRef.current < HISTORY_WINDOW_MS
      const entered = new Map<string, MembershipChange[]>()
      const left = new Map<string, MembershipChange[]>()

      for (const change of changes) {
        if (change.toFrameId && bindings.has(change.toFrameId)) {
          entered.set(change.toFrameId, [...(entered.get(change.toFrameId) ?? []), change])
        }
        if (!change.fromFrameId || !bindings.has(change.fromFrameId)) continue

        if (historyStep) {
          // Undo of a drop this layer categorized: revert that write too.
          const record = appliedRef.current.get(change.elementId)
          if (record && record.frameId === change.fromFrameId) {
            appliedRef.current.delete(change.elementId)
            void record.revert().catch((err: unknown) => {
              log.error('Failed to revert frame categorization on undo', err)
              trackRendererError('canvas_frame_revert', err)
            })
          }
          continue
        }

        const fromBinding = bindings.get(change.fromFrameId)!
        const toBinding = change.toFrameId ? bindings.get(change.toFrameId) : undefined
        // Moving between two values of one single-value property already
        // replaced the old value; there is nothing left to offer to remove.
        if (
          toBinding?.kind === 'property' &&
          fromBinding.kind === 'property' &&
          toBinding.property === fromBinding.property &&
          toBinding.propertyType !== 'multiselect'
        ) {
          continue
        }
        left.set(change.fromFrameId, [...(left.get(change.fromFrameId) ?? []), change])
      }

      for (const [frameId, group] of entered) {
        void categorize(frameId, bindings.get(frameId)!, group, true)
      }
      for (const [frameId, group] of left) {
        offerRemoval(bindings.get(frameId)!, group)
      }
    },
    [categorize, offerRemoval]
  )

  const process = useCallback((): void => {
    const appState = excalidrawAPI.getAppState() as unknown as AppState
    // Excalidraw reports its empty pre-load scene first; a baseline taken from
    // it would read every card of the stored board as "just dropped in".
    if (appState.isLoading) return
    const raw = excalidrawAPI.getSceneElementsIncludingDeleted()
    const elements = raw as unknown as FrameSceneElement[]
    refreshFrames(elements, appState)
    // Excalidraw replaces the elements array on every committed scene change
    // (including the drag end that assigns frameId) and keeps it on pan, zoom
    // and hover, so an unchanged array has nothing to diff.
    if (raw === lastElementsRef.current) return
    lastElementsRef.current = raw
    const next = cardMembership(elements)
    const previous = baselineRef.current
    baselineRef.current = next
    if (!previous || !editableRef.current) return
    const changes = diffMembership(previous, next)
    if (changes.length > 0) handleChanges(changes, elements)
  }, [excalidrawAPI, refreshFrames, handleChanges])

  useEffect(() => {
    process()
    positionChips()
    const unsubscribe = excalidrawAPI.onChange(() => {
      positionChips()
      if (frameRequestRef.current !== null) return
      frameRequestRef.current = requestAnimationFrame(() => {
        frameRequestRef.current = null
        process()
      })
    })
    return () => {
      unsubscribe()
      if (frameRequestRef.current !== null) {
        cancelAnimationFrame(frameRequestRef.current)
        frameRequestRef.current = null
      }
    }
  }, [excalidrawAPI, process, positionChips])

  // Undo/redo gestures. Excalidraw handles them on document, so they are
  // watched there too (capture, never consumed).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
        historyAtRef.current = Date.now()
      }
    }
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Element | null
      if (target?.closest('.undo-button-container, .redo-button-container')) {
        historyAtRef.current = Date.now()
      }
    }
    document.addEventListener('keydown', onKeyDown, { capture: true })
    document.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => {
      document.removeEventListener('keydown', onKeyDown, { capture: true })
      document.removeEventListener('pointerdown', onPointerDown, { capture: true })
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Binding a frame
  // ---------------------------------------------------------------------------

  const bindFrame = useCallback(
    (frameId: string, binding: FrameBinding | null): void => {
      const elements = sceneElements()
      const frame = elements.find((element) => element.id === frameId && !element.isDeleted)
      if (!frame) return
      const previous = readFrameBinding(frame.customData)
      if (sameBinding(previous, binding)) return
      // The frame's own title shows the binding (and does so on builds that
      // know nothing about bindings), unless the user named it themselves.
      const autoNamed = !frame.name || (previous !== null && frame.name === bindingLabel(previous))
      const name = autoNamed ? (binding ? bindingLabel(binding) : null) : frame.name
      replaceScene(
        elements.map((element) =>
          element.id === frameId
            ? bumpElement(element, {
                customData: withFrameBinding(element.customData, binding) ?? null,
                name
              })
            : element
        )
      )
      if (!binding) return
      // Cards already inside take the category too; that is what binding a
      // frame of sorted cards is for. Undo reverts the writes, not the binding.
      const inside: MembershipChange[] = []
      for (const [elementId, placement] of cardMembership(elements)) {
        if (placement.frameId !== frameId) continue
        inside.push({
          elementId,
          entityType: placement.entityType,
          entityId: placement.entityId,
          fromFrameId: frameId,
          toFrameId: frameId,
          before: null
        })
      }
      if (inside.length > 0) void categorize(frameId, binding, inside, false)
    },
    [sceneElements, replaceScene, categorize]
  )

  // ---------------------------------------------------------------------------
  // Lay out by property
  // ---------------------------------------------------------------------------

  const layoutByProperty = useCallback(
    async (property: BindableProperty): Promise<void> => {
      const tr = tRef.current
      try {
        const cards = getCardRefs(sceneElements())
        const valued = await Promise.all(
          cards.map(async (card) => {
            if (card.entityType !== 'note') return null
            const properties = await propertiesService.get(card.entityId).catch(() => [])
            const current = properties.find((entry) => entry.name === property.name)?.value
            const values = property.values.filter((value) => hasPropertyValue(current, value))
            return values.length > 0 ? { card, values } : null
          })
        )
        // Read the scene again: the reads above took time, and a card moved or
        // deleted meanwhile must not be resurrected at its old place.
        const elements = sceneElements()
        const live = new Set(getCardRefs(elements).map((card) => card.elementId))
        const layoutCards = valued
          .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
          .filter((entry) => live.has(entry.card.elementId))
          .map((entry) => ({
            elementId: entry.card.elementId,
            width: entry.card.width,
            height: entry.card.height,
            values: entry.values
          }))

        const appState = excalidrawAPI.getAppState() as unknown as AppState
        const rect = viewportSceneRect(appState, {
          width: window.innerWidth,
          height: window.innerHeight
        })
        const origin = layoutOrigin(elements, {
          x: (rect.minX + rect.maxX) / 2,
          y: (rect.minY + rect.maxY) / 2
        })
        const plan = planPropertyLayout({ options: property.values, cards: layoutCards, origin })

        const skeletons = plan.frames.map((frame) => {
          const binding: FrameBinding = {
            kind: 'property',
            property: property.name,
            value: frame.value,
            propertyType: property.type
          }
          return {
            type: 'frame' as const,
            children: [],
            name: bindingLabel(binding),
            customData: withFrameBinding(null, binding)
          }
        })
        const created = convertToExcalidrawElements(
          skeletons as unknown as Parameters<typeof convertToExcalidrawElements>[0]
        ).map((element, index) => {
          // Geometry is set after conversion: the skeleton path recomputes a
          // childless frame's box from its (absent) children and treats a zero
          // coordinate as "unset".
          const frame = plan.frames[index]
          return {
            ...(element as unknown as FrameSceneElement),
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height
          }
        })

        let next: FrameSceneElement[] = [
          ...elements.map((element) => {
            const move = plan.moves.get(element.id)
            return move ? bumpElement(element, { x: move.x, y: move.y }) : element
          }),
          ...created
        ]
        plan.frames.forEach((frame, index) => {
          next = placeInFrame(next, new Set(frame.childIds), created[index].id)
        })
        replaceScene(next)
        excalidrawAPI.scrollToContent(created as never, { fitToContent: true, animate: true })
        toast.success(
          tr('canvas.frame.layoutDone', {
            count: created.length,
            property: property.name
          })
        )
      } catch (err) {
        log.error('Failed to lay out canvas by property', err)
        trackRendererError('canvas_frame_layout', err)
        toast.error(extractErrorMessage(err, tr('canvas.frame.layoutFailed')))
      }
    },
    [excalidrawAPI, sceneElements, replaceScene]
  )

  const bindingFrame = frames.find((frame) => frame.id === bindingFrameId) ?? null
  const chips = frames.filter(
    (frame) => frame.binding || (editable && frame.id === selectedFrameId)
  )

  return (
    <>
      {/* Above the card overlay (z-[3]) so a chip over a card stays clickable;
          below Excalidraw's own toolbars and menus (z-index 4+ inside
          .excalidraw, which is a later sibling). */}
      <div
        ref={layerRef}
        className="pointer-events-none absolute inset-0 z-[3] overflow-hidden"
        data-canvas-frame-layer=""
      >
        {chips.map((frame) => {
          const content = frame.binding ? (
            <>
              {frame.binding.kind === 'tag' ? (
                <Hash className="size-3 shrink-0" aria-hidden="true" />
              ) : (
                <Tag className="size-3 shrink-0" aria-hidden="true" />
              )}
              <span className="max-w-48 truncate">
                {frame.binding.kind === 'tag'
                  ? frame.binding.tag
                  : `${frame.binding.property}: ${frame.binding.value}`}
              </span>
              <span className="text-text-tertiary" data-testid="canvas-frame-count">
                {t('canvas.frame.cardCount', { count: frame.cardCount })}
              </span>
            </>
          ) : (
            <>
              <Tag className="size-3 shrink-0" aria-hidden="true" />
              <span>{t('canvas.frame.categorize')}</span>
            </>
          )
          const className =
            'absolute start-0 top-0 flex items-center gap-1 whitespace-nowrap rounded-full border border-border bg-card px-2 py-0.5 text-xs text-text-secondary shadow-sm'
          return editable ? (
            <button
              key={frame.id}
              type="button"
              data-canvas-frame-chip={frame.id}
              data-testid={`canvas-frame-chip-${frame.id}`}
              style={{ transform: chipTransform(frame) }}
              title={t('canvas.frame.editBinding')}
              onClick={() => setBindingFrameId(frame.id)}
              className={`${className} pointer-events-auto transition-colors hover:bg-muted hover:text-foreground`}
            >
              {content}
            </button>
          ) : (
            <span
              key={frame.id}
              data-canvas-frame-chip={frame.id}
              data-testid={`canvas-frame-chip-${frame.id}`}
              style={{ transform: chipTransform(frame) }}
              className={className}
            >
              {content}
            </span>
          )
        })}
      </div>
      <CanvasFrameBindingDialog
        open={bindingFrameId !== null}
        onOpenChange={(open) => {
          if (!open) setBindingFrameId(null)
        }}
        current={bindingFrame?.binding ?? null}
        onPick={(binding) => {
          if (bindingFrameId) bindFrame(bindingFrameId, binding)
        }}
        onUnbind={() => {
          if (bindingFrameId) bindFrame(bindingFrameId, null)
        }}
      />
      <CanvasFrameLayoutDialog
        open={layoutOpen}
        onOpenChange={onLayoutOpenChange}
        onPick={(property) => void layoutByProperty(property)}
      />
    </>
  )
}
