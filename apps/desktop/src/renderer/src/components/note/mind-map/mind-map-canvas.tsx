/**
 * The Excalidraw-importing chunk of the mind map.
 *
 * Loaded lazily from `MindMapView` for the same reason `CanvasEditor` is loaded
 * lazily from `CanvasPage`: @excalidraw/excalidraw and its CSS stay out of the
 * main renderer bundle, and are never fetched by a user who never opens a map.
 * Fonts are self-hosted (see public/excalidraw-asset-path.js) because the CSP
 * blocks Excalidraw's CDN.
 *
 * Read-only by construction: the map is a derived view of the note, never a
 * document, so the surface is mounted in view mode and nothing here writes.
 *
 * The toolbar's actions are handed UP from here rather than reaching down,
 * because everything they need — the live scene and the export functions — is
 * inside this chunk, while the toolbar itself must render as a sibling of the
 * map's image region. (Anything inside an `img` role is presentational, so a
 * toolbar nested in it would be invisible to exactly the readers the accessible
 * projection exists for.)
 *
 * This chunk also owns the map's LINK AFFORDANCE, which used to be the drawing
 * library's job. A box carrying `element.link` gets a permanent blue glyph and
 * a hover bubble printing the raw href; on a canvas where a few shapes are
 * linked that marks something, and on a map where every box is it marks
 * nothing and buries the shape the picture exists to show. There is no
 * hover-gate for the glyph and no supported way to ask what is under the
 * cursor, so the map keeps its href out of `link` (see `mintElements`) and
 * re-implements the three things that field was buying: the pointer cursor
 * (`mind-map-canvas.css`), the hover affordance below, and click-to-open. The
 * hit test is the whole bounding box, which is what view mode gave us and why
 * clicking anywhere on a node has always worked.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Excalidraw,
  convertToExcalidrawElements,
  viewportCoordsToSceneCoords
} from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import { useReducedMotion } from 'motion/react'
import { useTheme } from 'next-themes'
import { ExternalLink, Link } from '@/lib/icons'
import { copySceneAsImage, copySceneAsVector, toSkeleton } from './mind-map-export'
import {
  hitMindMapBox,
  mindMapBoxRect,
  mindMapHoverAnchor,
  mindMapHrefOf,
  type MindMapHitElement
} from './mind-map-hover'
import type { MindMapElement } from './mind-map-types'
import './mind-map-canvas.css'

/**
 * What the map's toolbar can do, closed over the live surface.
 *
 * Each copy rejects on failure rather than swallowing it — the host turns that
 * into something the user can read, so a failed export is never silent.
 */
export interface MindMapControls {
  /** Frame the whole drawing again, whatever the user panned or zoomed to. */
  fit: () => void
  /**
   * Centre the camera on one box, named by the href it carries, and leave the
   * zoom alone.
   *
   * The zoom is deliberately untouched: this is how the outline panel navigates
   * a map that is already open, and a jump that also rescaled the picture would
   * take away the reading distance the user chose. False when no box on the
   * live scene carries that href, which is the caller's signal to do something
   * else entirely rather than to leave the click doing nothing.
   */
  focus: (href: string) => boolean
  copyImage: () => Promise<void>
  copyVector: () => Promise<void>
}

/** What the affordance says about one node, composed by the host. */
export interface MindMapHoverLabel {
  /**
   * Where the click goes, as a short chain — `… → Q3 Risks → Hire a designer`.
   * Node labels, note titles and headings are user content; only the separator
   * between them is translated.
   */
  chain: string
  /**
   * Translated, and set only when the link leaves this note. It is the same
   * sentence the accessible tree gives a wiki-link node, so the picture and the
   * tree cannot say different things — and it is what tells a reader that
   * `Roadmap` is another page rather than a section of this one.
   */
  hint: string | null
}

/** How far the pointer may travel between press and release and still be a click. */
const CLICK_SLOP = 4

/**
 * How long the camera takes to fly to a focused box.
 *
 * Pinned rather than left to the library's own default, because the flash below
 * has to outlast the flight: a ring that finished while the map was still
 * moving would mark the arrival of nothing. An upgrade that changed the default
 * would silently break that relationship.
 */
const FOCUS_CAMERA_MS = 250

/**
 * How long the ring stays on the box, flight included.
 *
 * The `mind-map-focus-flash` keyframes hold it solid over the flight and the
 * beat after it, then fade — so the eye is led to the box rather than shown a
 * marker that was already gone by the time the map settled.
 */
const FOCUS_FLASH_MS = 600

interface MindMapHoverState {
  /**
   * The drawing this answer was computed against, held only to be compared by
   * identity. A rebuilt map is a different drawing at different coordinates, so
   * an answer from the old one is discarded on sight rather than cleared by an
   * effect — the surface refits on a rebuild, and an affordance left pinned to
   * where a box used to be is worse than none.
   */
  drawing: readonly MindMapElement[]
  href: string
  /** Pixels from the drawing surface's own origin. See `mindMapHoverAnchor`. */
  x: number
  y: number
}

interface MindMapCanvasProps {
  elements: readonly MindMapElement[]
  /**
   * Deep link → what to say about the node carrying it. Keyed by href because
   * that is what a box carries and what a hit test hands back; every box has
   * one of its own, so the keys cannot collide.
   */
  hoverLabels: ReadonlyMap<string, MindMapHoverLabel>
  /** The deep link of the box that was clicked. See `handleMindMapLinkOpen`. */
  onOpenLink: (href: string) => void
  /**
   * The box to open on, rather than the whole drawing — the section the user was
   * reading when they asked for the map.
   *
   * Read at the moment the scene is fed, never watched: a value that moved the
   * camera every time it changed would fight the user for it. Null, or an href
   * no box carries, leaves the map framed whole, which is the only honest answer
   * for a note with nothing above the fold to focus on.
   */
  initialFocusHref?: string | null
  /**
   * Called with the controls once the surface is live, and with `null` when it
   * goes away, so the toolbar is never wired to a surface that is not there.
   */
  onControlsChange?: (controls: MindMapControls | null) => void
}

/** The pointer position, in the two fields both the library and we read. */
type PointerPosition = Pick<React.PointerEvent, 'clientX' | 'clientY'>

export function MindMapCanvas({
  elements,
  hoverLabels,
  onOpenLink,
  initialFocusHref = null,
  onControlsChange
}: MindMapCanvasProps): React.JSX.Element {
  const { resolvedTheme } = useTheme()
  const prefersReducedMotion = useReducedMotion()
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  // The same instance as a piece of state, purely so an effect can subscribe to
  // it once it exists: a ref assignment does not re-run one.
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  const [hovered, setHovered] = useState<MindMapHoverState | null>(null)
  /** The box the outline panel last sent the camera to, while its ring lasts. */
  const [focusedHref, setFocusedHref] = useState<string | null>(null)
  const [focusRect, setFocusRect] = useState<{
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const flashRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Last seen pointer, so a pan or a zoom can re-answer without a mouse move. */
  const pointerRef = useRef<PointerPosition | null>(null)
  /** Where the press started, so a drag to pan is not read as a click. */
  const pressRef = useRef<PointerPosition | null>(null)
  const frameRef = useRef<number | null>(null)

  /**
   * Stable, and it has to be: the surface hands its instance back through this,
   * and taking the instance into state means every call re-renders. An inline
   * arrow would be a new prop each time, and a surface that re-announced itself
   * on a prop change would then announce itself forever.
   */
  const handleApi = useCallback((instance: ExcalidrawImperativeAPI): void => {
    apiRef.current = instance
    setApi(instance)
  }, [])

  /**
   * Latest focus target, kept where the scene effect can read it without
   * depending on it. A layout effect rather than an assignment during render,
   * and it runs before the passive effect below on the very first commit too.
   */
  const focusRef = useRef(initialFocusHref)
  useLayoutEffect(() => {
    focusRef.current = initialFocusHref
  }, [initialFocusHref])

  /**
   * The live element carrying this href, or null.
   *
   * The LIVE scene, for the same reason the hit test reads it: the library
   * regenerates every id on import, so the elements this was built from cannot
   * be handed to the camera. `customData` is what survives.
   */
  const elementForHref = useCallback((href: string) => {
    const api = apiRef.current
    if (!api) return null
    return (
      api
        .getSceneElements()
        .find(
          (element) =>
            !element.isDeleted && mindMapHrefOf(element as unknown as MindMapHitElement) === href
        ) ?? null
    )
  }, [])

  // Re-feeding the scene rather than remounting keeps the camera and the
  // library's own warm-up across a rebuild of the same note.
  //
  // Framed whole first, then centred on the focus target. The fit is what
  // decides the ZOOM — there is no other source for a sensible one, and the
  // centring step deliberately does not change it — and both land in the same
  // frame, so the whole-map view is never a thing the user sees on the way past.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    api.updateScene({ elements: convertToExcalidrawElements(toSkeleton(elements)) })
    api.scrollToContent(undefined, { fitToContent: true, animate: false })

    const href = focusRef.current
    const target = href === null ? null : elementForHref(href)
    if (target) api.scrollToContent(target, { animate: false })
  }, [elements, elementForHref])

  /**
   * The box under a viewport point, read from the LIVE scene.
   *
   * The live scene rather than the elements this was built from, because the
   * library regenerates every id on the way in — which is exactly why the href
   * travels in `customData`, the one field that survives the conversion.
   */
  const hitAt = useCallback((point: PointerPosition) => {
    const api = apiRef.current
    if (!api) return null
    const scene = viewportCoordsToSceneCoords(point, api.getAppState())
    return hitMindMapBox(api.getSceneElements() as unknown as readonly MindMapHitElement[], scene)
  }, [])

  const syncHover = useCallback((): void => {
    const api = apiRef.current
    const pointer = pointerRef.current
    if (!api || !pointer) {
      setHovered(null)
      return
    }

    const hit = hitAt(pointer)
    if (!hit || !hoverLabels.has(hit.href)) {
      setHovered(null)
      return
    }

    const anchor = mindMapHoverAnchor(hit, api.getAppState())
    // Same box, same place — hand back the very same object so React does not
    // re-render. The affordance is pinned to the BOX, so moving the pointer
    // inside one node costs nothing at all.
    setHovered((current) =>
      current &&
      current.drawing === elements &&
      current.href === hit.href &&
      current.x === anchor.x &&
      current.y === anchor.y
        ? current
        : { drawing: elements, href: hit.href, x: anchor.x, y: anchor.y }
    )
  }, [elements, hitAt, hoverLabels])

  /**
   * Where the ring goes, against the camera as it is right now.
   *
   * Recomputed on every committed change for the same reason the affordance is,
   * and then some: the camera is still flying when the ring appears, so a
   * rectangle measured once at the click would sit where the box USED to be for
   * the whole flight.
   */
  const syncFocus = useCallback((): void => {
    const api = apiRef.current
    if (!api || focusedHref === null) {
      setFocusRect(null)
      return
    }

    const target = elementForHref(focusedHref)
    if (!target) {
      setFocusRect(null)
      return
    }

    const rect = mindMapBoxRect(target, api.getAppState())
    // Same box, same place: hand back the very same object so a pan that does
    // not move this node does not re-render the ring.
    setFocusRect((current) =>
      current &&
      current.left === rect.left &&
      current.top === rect.top &&
      current.width === rect.width &&
      current.height === rect.height
        ? current
        : rect
    )
  }, [elementForHref, focusedHref])

  /**
   * A pan or a zoom moves the drawing under a pointer that never moved, so the
   * answer has to be recomputed from a change rather than from a mouse event.
   * Coalesced onto a frame because the library reports every committed state
   * change, a pan tick included, and each answer costs a scene read.
   */
  useEffect(() => {
    if (!api) return
    const unsubscribe = api.onChange(() => {
      if (frameRef.current !== null) return
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null
        syncHover()
        syncFocus()
      })
    })
    return () => {
      unsubscribe()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [api, syncHover, syncFocus])

  const handlePointerMove = useCallback(
    (event: React.PointerEvent): void => {
      pointerRef.current = { clientX: event.clientX, clientY: event.clientY }
      syncHover()
    },
    [syncHover]
  )

  const handlePointerLeave = useCallback((): void => {
    pointerRef.current = null
    setHovered(null)
  }, [])

  const handlePointerDown = useCallback((event: React.PointerEvent): void => {
    pressRef.current = { clientX: event.clientX, clientY: event.clientY }
  }, [])

  /**
   * Click-to-open, re-implemented.
   *
   * Hit-tested again at the release point rather than trusting the hovered
   * state, so a click always opens the box it landed on. A press that travelled
   * is a pan, not a click — in view mode a drag anywhere moves the camera, and
   * finishing a pan over a node must not open it.
   */
  const handleClick = useCallback(
    (event: React.MouseEvent): void => {
      const press = pressRef.current
      pressRef.current = null
      if (
        press &&
        Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY) > CLICK_SLOP
      ) {
        return
      }

      const hit = hitAt(event)
      if (hit) onOpenLink(hit.href)
    },
    [hitAt, onOpenLink]
  )

  const fit = useCallback((): void => {
    apiRef.current?.scrollToContent(undefined, { fitToContent: true, animate: true })
  }, [])

  /**
   * Neither `fitToContent` nor `fitToViewport` is passed, and that is the whole
   * point: with no fit option the library only moves the camera, so the box
   * arrives in the middle of the view at exactly the scale the user left it at.
   */
  const focus = useCallback(
    (href: string): boolean => {
      const api = apiRef.current
      const target = api ? elementForHref(href) : null
      if (!api || !target) return false

      api.scrollToContent(target, {
        animate: !prefersReducedMotion,
        duration: FOCUS_CAMERA_MS
      })

      // Restarted rather than queued: clicking a second heading while the first
      // ring is still up marks the second box, not both.
      if (flashRef.current !== null) clearTimeout(flashRef.current)
      setFocusedHref(href)
      flashRef.current = setTimeout(() => {
        flashRef.current = null
        setFocusedHref(null)
      }, FOCUS_FLASH_MS)
      return true
    },
    [elementForHref, prefersReducedMotion]
  )

  // The ring appears at the click rather than on the next committed change: the
  // camera reports its flight, but a focus that did not move it at all — the
  // box was already centred — reports nothing to hang the first frame off.
  useLayoutEffect(() => {
    syncFocus()
  }, [syncFocus])

  useEffect(
    () => () => {
      if (flashRef.current !== null) clearTimeout(flashRef.current)
    },
    []
  )

  // Read through the ref at call time, never captured at build time: the point
  // of exporting from the live surface is that it holds whatever the map shows
  // right now, expanded branches included.
  const copyImage = useCallback(async (): Promise<void> => {
    const api = apiRef.current
    if (!api) return
    await copySceneAsImage(api)
  }, [])

  const copyVector = useCallback(async (): Promise<void> => {
    const api = apiRef.current
    if (!api) return
    await copySceneAsVector(api)
  }, [])

  const controls = useMemo<MindMapControls>(
    () => ({ fit, focus, copyImage, copyVector }),
    [fit, focus, copyImage, copyVector]
  )

  useEffect(() => {
    onControlsChange?.(controls)
    return () => onControlsChange?.(null)
  }, [controls, onControlsChange])

  // Discarded rather than cleared: see `MindMapHoverState.drawing`.
  const hover = hovered && hovered.drawing === elements ? hovered : null
  const label = hover ? (hoverLabels.get(hover.href) ?? null) : null
  // A link out of the note is drawn differently on the map; the affordance says
  // the same thing with its icon.
  const HoverIcon = label?.hint === null ? Link : ExternalLink

  return (
    <div
      // The class is what the pointer-cursor rule hangs off; the attribute is
      // what switches it on.
      className="mind-map-surface relative h-full w-full"
      data-node-hover={hover ? 'true' : undefined}
      // Capture phase: these have to answer whatever the drawing surface does
      // with the event afterwards.
      onPointerDownCapture={handlePointerDown}
      onPointerMoveCapture={handlePointerMove}
      onClickCapture={handleClick}
      onPointerLeave={handlePointerLeave}
    >
      <Excalidraw
        excalidrawAPI={handleApi}
        initialData={{
          elements: convertToExcalidrawElements(toSkeleton(elements)),
          appState: { viewBackgroundColor: 'transparent' },
          scrollToContent: true
        }}
        viewModeEnabled
        zenModeEnabled
        UIOptions={{
          canvasActions: {
            export: false,
            loadScene: false,
            saveToActiveFile: false,
            changeViewBackgroundColor: false,
            clearCanvas: false,
            toggleTheme: false
          }
        }}
        // Three Memry themes exist (light/dark/white); anything not dark maps to
        // Excalidraw's light theme.
        theme={resolvedTheme === 'dark' ? 'dark' : 'light'}
      />

      {focusRect && (
        /* What the click landed on, said in the one language a bitmap surface
           has. Decoration, like the hover card: the outline entry the user just
           pressed already named this node in words, so repeating it to assistive
           technology would announce the same thing twice. Never a pointer
           target, and clipped to the map so a ring on a node at the edge cannot
           spill over the toolbar. */
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div
            data-testid="mind-map-focus-ring"
            className="mind-map-focus-ring absolute rounded-md ring-2 ring-accent-orange"
            // Geometry on the drawing surface's own axes, not layout: a logical
            // inset here would put the ring on the wrong side of an RTL map.
            style={{
              left: focusRect.left,
              top: focusRect.top,
              width: focusRect.width,
              height: focusRect.height,
              // Driven from the constant that also decides when the ring is
              // unmounted, so the fade cannot outlive the element or end early.
              animationDuration: `${FOCUS_FLASH_MS}ms`
            }}
          />
        </div>
      )}

      {label && hover && (
        /* Decoration on the picture, and deliberately so: it is a mouse-only
           affordance whose content the accessible tree beside the map already
           carries in words. Hidden from assistive technology rather than
           duplicated into it, and never a pointer target — every event has to
           reach the surface underneath. Clipped to the map so it can never
           spill over the toolbar or the note around it. */
        <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
          <div
            data-testid="mind-map-hover-card"
            className="absolute z-10 flex max-w-[min(20rem,90%)] -translate-x-1/2 translate-y-2 items-center gap-1.5 rounded-md border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
            // Pixels on the drawing surface's own axes, whose origin is the
            // same corner in either reading direction — geometry, not layout,
            // so a logical inset here would put the card on the wrong side of
            // an RTL map.
            style={{ left: hover.x, top: hover.y }}
          >
            <HoverIcon className="size-3.5 shrink-0 text-text-tertiary" />
            <span className="truncate">{label.chain}</span>
            {label.hint !== null && (
              <span className="shrink-0 text-text-tertiary">{label.hint}</span>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
