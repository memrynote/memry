/**
 * Scroll arithmetic for the large-file viewer's scaled mode.
 *
 * Above `LARGE_FILE_SCALED_LINES` the scrollbar no longer spans the file's real
 * height: 30 million lines at 32 px is about 1 billion px, thirty times the
 * tallest box WebKit or Chromium will lay out (about 33.5 million px). Instead
 * the scrollbar spans a fixed `scaledSpan` and its position is a fraction of the
 * file. Only a window of rows around the anchor line is laid out, so nothing
 * grows with the line count.
 */

/**
 * Line count above which the viewer scales its scrollbar instead of giving
 * every line a slot. Below it, TanStack Virtual's per-row measurement array is
 * a few MB and the total height stays well under the layout limit.
 */
export const LARGE_FILE_SCALED_LINES = 100_000

/** Where the viewport sits: a line, and how many px of it are above the top edge. */
export interface ScrollAnchor {
  line: number
  /** Px of `line` scrolled past the top. Negative puts the line below the top. */
  offset: number
}

/** Height of the scaled scrollbar's range, the height the cap file would have. */
export function scaledSpan(rowHeight: number): number {
  return LARGE_FILE_SCALED_LINES * rowHeight
}

/** Last line the scrollbar can put at the top, leaving a viewport of lines below it. */
export function maxAnchorLine(lineCount: number, visibleRows: number): number {
  return Math.max(0, lineCount - Math.max(1, visibleRows))
}

/**
 * The line a scrollbar position stands for:
 * `round(scrollTop / maxScroll × (lineCount − visible))`.
 *
 * The bottom of the track is the end of the file, not the last top line: a
 * drag to the bottom asks to see the last line, which rows taller than the
 * estimate would otherwise push out of view. `settle` clamps the huge offset
 * so the last line sits on the bottom edge.
 */
export function anchorForScrollTop(
  scrollTop: number,
  maxScroll: number,
  lineCount: number,
  visibleRows: number
): ScrollAnchor {
  if (lineCount <= 0 || maxScroll <= 0) return { line: 0, offset: 0 }
  if (scrollTop >= maxScroll - 1) return endAnchor(lineCount)
  const fraction = Math.min(1, Math.max(0, scrollTop / maxScroll))
  return { line: Math.round(fraction * maxAnchorLine(lineCount, visibleRows)), offset: 0 }
}

/** The scrollbar position that stands for `line`, the inverse of `anchorForScrollTop`. */
export function scrollTopForLine(
  line: number,
  maxScroll: number,
  lineCount: number,
  visibleRows: number
): number {
  const last = maxAnchorLine(lineCount, visibleRows)
  if (last === 0 || maxScroll <= 0) return 0
  return Math.min(1, Math.max(0, line / last)) * maxScroll
}

/** An anchor that `settle` resolves to the last line on the bottom edge. */
export function endAnchor(lineCount: number): ScrollAnchor {
  return { line: Math.max(0, lineCount - 1), offset: Number.MAX_SAFE_INTEGER }
}

/**
 * Moves `anchor.offset` into the anchor line's own height by stepping lines,
 * so a wheel turn of any size lands on a line and a px within it. Clamped to
 * the top of the file; the bottom is clamped by layout, which knows where the
 * last line ends.
 */
export function settle(
  anchor: ScrollAnchor,
  heightOf: (line: number) => number,
  lineCount: number
): ScrollAnchor {
  let { line, offset } = anchor
  const last = Math.max(0, lineCount - 1)
  while (offset < 0 && line > 0) {
    line -= 1
    offset += heightOf(line)
  }
  if (offset < 0) return { line: 0, offset: 0 }
  while (line < last && offset >= heightOf(line)) {
    offset -= heightOf(line)
    line += 1
  }
  return { line, offset }
}
