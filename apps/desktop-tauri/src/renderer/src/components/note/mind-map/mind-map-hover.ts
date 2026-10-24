/**
 * Finding the node under the cursor, and where to pin the affordance for it.
 *
 * The drawing library gives us neither. Its own link affordance is driven by
 * `element.link`, which paints a permanent glyph on every element that has one
 * — useful on a real canvas where a handful of shapes are linked, pure noise on
 * a map where every single box is. There is no prop, `appState` field or CSS
 * surface that hover-gates that glyph, and no supported way to ask which
 * element is under the pointer either: `onPointerUpdate` hands over raw
 * coordinates with no hit-test result, `appState.hoveredElementIds` is only
 * populated while the element-link picker is open, and the real hit test
 * (`isPointHittingLink`) is not exported — the package's type map resolves it,
 * so importing it type-checks and then fails at bundle time.
 *
 * So the map carries its href in `customData` instead, where nothing paints it,
 * and answers "what is under the cursor" here.
 *
 * Pure and library-free on purpose: the shapes below are the narrow slice of a
 * scene element and of the camera that this reads, so the whole hit test unit
 * tests without a canvas — which jsdom does not have.
 */

/** Where a box's deep link is carried on the drawn map. See `mintElements`. */
export const MIND_MAP_HREF_KEY = 'memryHref'

/** The slice of a scene element the hit test reads. */
export interface MindMapHitElement {
  x: number
  y: number
  width: number
  height: number
  isDeleted?: boolean
  customData?: Record<string, unknown> | null
}

/** The box that was hit: its href, and its rectangle in scene units. */
export interface MindMapHit {
  href: string
  x: number
  y: number
  width: number
  height: number
}

/** The slice of the camera the anchor math reads. */
export interface MindMapCamera {
  scrollX: number
  scrollY: number
  zoom: { value: number }
}

/** A point in scene units. */
export interface MindMapScenePoint {
  x: number
  y: number
}

/**
 * The deep link a drawn box carries, or null when this element is not one of
 * ours (a connector, a strike rule, the text bound into a box).
 */
export function mindMapHrefOf(element: MindMapHitElement): string | null {
  const href = element.customData?.[MIND_MAP_HREF_KEY]
  return typeof href === 'string' && href !== '' ? href : null
}

/**
 * The box under a point, or null.
 *
 * The WHOLE bounding box is the hit area, deliberately. That is what view mode
 * was doing for us — `isPointHittingLink` widens to the element's bounding box
 * in view mode on desktop — and it is why a click anywhere on a node has always
 * opened it. A hit test that only answered for the 14px glyph would technically
 * restore "click to open" and in practice take the feature away.
 *
 * Walked from the end, so the box drawn last wins where two overlap. A tidy
 * tree never overlaps its own boxes, but the rule costs nothing and means the
 * answer never depends on that staying true.
 */
export function hitMindMapBox(
  elements: readonly MindMapHitElement[],
  point: MindMapScenePoint
): MindMapHit | null {
  for (let index = elements.length - 1; index >= 0; index -= 1) {
    const element = elements[index]
    if (!element || element.isDeleted) continue

    const href = mindMapHrefOf(element)
    if (href === null) continue

    if (point.x < element.x || point.x > element.x + element.width) continue
    if (point.y < element.y || point.y > element.y + element.height) continue

    return { href, x: element.x, y: element.y, width: element.width, height: element.height }
  }
  return null
}

/**
 * Where the affordance sits, in pixels from the drawing surface's own origin.
 *
 * Under the box and centred on it. Centred rather than aligned to one end
 * because the map mirrors in RTL and a tooltip anchored to a fixed side would
 * then hang off the wrong end of every node; the midpoint reads the same in
 * both directions.
 *
 * The axes here are the canvas viewport's, not the page's layout: the origin is
 * the surface's top corner in either reading direction, so this is geometry
 * rather than a direction-sensitive position. It is the inverse of the
 * transform the drawing applies to the scene (`(scene + scroll) * zoom`), which
 * is the same arithmetic `CanvasCardLayer` uses to lay its cards over a scene.
 */
/**
 * A box's rectangle in pixels on the drawing surface's own axes.
 *
 * The same transform the affordance anchor uses — `(scene + scroll) * zoom` —
 * applied to the whole box rather than to one point on it, because a ring drawn
 * around a node has to sit exactly on it at any zoom. Recomputed against the
 * live camera on every committed change, so it stays glued to the box while the
 * camera is still flying towards it.
 */
export function mindMapBoxRect(
  box: { x: number; y: number; width: number; height: number },
  camera: MindMapCamera
): { left: number; top: number; width: number; height: number } {
  const zoom = camera.zoom.value || 1
  return {
    left: (box.x + camera.scrollX) * zoom,
    top: (box.y + camera.scrollY) * zoom,
    width: box.width * zoom,
    height: box.height * zoom
  }
}

export function mindMapHoverAnchor(
  hit: MindMapHit,
  camera: MindMapCamera
): { x: number; y: number } {
  const zoom = camera.zoom.value || 1
  return {
    x: (hit.x + hit.width / 2 + camera.scrollX) * zoom,
    y: (hit.y + hit.height + camera.scrollY) * zoom
  }
}
