/**
 * How much the map draws before it starts folding.
 *
 * Private to this directory, like every other step behind `buildMindMap`. The
 * numbers live in one file because they are a single readability budget rather
 * than four unrelated knobs, and because a test that asserts a cap should name
 * the cap rather than repeat its value.
 *
 * The governing rule that shapes all four: nothing disappears silently. Every
 * cap here has a visible consequence — a clipped label ends in an ellipsis, an
 * over-deep or over-budget node is counted on the nearest node still drawn, and
 * a parent with too many children grows a "+N more" node that opens it again.
 */

/**
 * Deepest node the map draws, counted in nodes still drawn below the root.
 *
 * Six is the depth a note actually reaches: markdown stops at six heading
 * levels, and by the time a bullet is six branches from the title the map is
 * already three thousand pixels wide. Depth is counted in VISIBLE ancestors,
 * not in source nesting, so a blank heading or an unlabelled bullet — neither
 * of which draws a box — costs nothing against this.
 */
export const MIND_MAP_MAX_DEPTH = 6

/**
 * Longest label a box holds, the clipping ellipsis included.
 *
 * A box caps at 264px wide and holds about 25 characters a line, so this is
 * three lines: enough to recognise a heading, short enough that one wordy node
 * cannot dominate the column it sits in. Clipping is not a loss — the ellipsis
 * says it happened, and the node still navigates to the block with the full
 * text in it.
 */
export const MIND_MAP_MAX_LABEL_CHARS = 72

/**
 * Most children one parent draws, the "+N more" node included.
 *
 * Twelve boxes at roughly 58px apiece is a screenful, which is the point: past
 * that the user is scrolling a list rather than reading a shape. The overflow
 * is a fold, not a loss — the "+N more" node opens it in place.
 */
export const MIND_MAP_MAX_CHILDREN = 12

/**
 * Most nodes the whole map draws, the root and every "+N more" node included.
 *
 * Past this the picture stops being readable and its accessible twin stops
 * being walkable. Whatever is over budget is counted on the nearest node still
 * drawn, and the map says it hit the limit.
 */
export const MIND_MAP_MAX_NODES = 200

/** The clipping mark. Punctuation, not language: labels are user content. */
const ELLIPSIS = '…'

/**
 * A label as a box can hold it.
 *
 * Clips inside the cap rather than past it, so the returned string is never
 * longer than the cap even once the ellipsis is on the end.
 */
export function clipLabel(label: string): string {
  if (label.length <= MIND_MAP_MAX_LABEL_CHARS) return label
  return `${label.slice(0, MIND_MAP_MAX_LABEL_CHARS - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`
}
