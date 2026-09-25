/**
 * Sigma draws a node label only when the node's rendered size, `size / sqrt(cameraRatio)`,
 * reaches `labelRenderedSizeThreshold`. Graph node sizes (see `computeNodeSize` in
 * graph-builder) start at 2 (unresolved) and 3 (leaf), so sigma's default of 6 kept
 * those labels hidden until a 4x-9x zoom. At 2.5 every resolved node is label-eligible
 * at the default zoom and unresolved ones from about 1.6x. Sigma's label grid (one
 * label per 100px cell at the default zoom, more as the camera zooms in) keeps the
 * overview readable, and zooming out still drops leaf labels first.
 */
const GRAPH_LABEL_RENDERED_SIZE_THRESHOLD = 2.5

/** Show Labels off keeps labels hover-only: hovered nodes and search hits use `forceLabel`. */
export function graphLabelRenderedSizeThreshold(showLabels: boolean): number {
  return showLabels ? GRAPH_LABEL_RENDERED_SIZE_THRESHOLD : Infinity
}
