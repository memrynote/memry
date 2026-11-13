import type { CriticMarkupMark } from '@memry/shared'

/**
 * `marks` over `previous`, moved to where their text is in `next`, which is `previous` with one
 * range replaced (the editor's text after a change). The window owns an open note's marks in the
 * Y.Doc (#4425), so offsets left as they were would point at other text on every device, and
 * the serializer would move a comment to the first copy of its words.
 *
 * One diff (common prefix and suffix) cannot tell where text typed at a mark's edge went when it
 * repeats the mark's edge letter, nor place a mark between two edits of one batch. A mark whose
 * mapped range no longer holds its words takes the copy of them nearest to where it was, inside
 * the span the edit touched, so text typed at a mark's edge stays out of it. A mark whose own
 * words changed keeps the mapped range, and the serializer relocates or drops it as before.
 * Returns `marks` itself when none moved.
 */
export function rebaseMarks(
  previous: string,
  next: string,
  marks: CriticMarkupMark[]
): CriticMarkupMark[] {
  if (previous === next || marks.length === 0) return marks
  const shortest = Math.min(previous.length, next.length)
  let prefix = 0
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix++
  }
  const changedEnd = previous.length - suffix
  const delta = next.length - previous.length
  const start = (offset: number): number =>
    offset >= changedEnd ? offset + delta : Math.min(offset, prefix)
  const end = (offset: number): number =>
    offset <= prefix ? offset : Math.max(offset, changedEnd) + delta

  const place = (mark: CriticMarkupMark): [number, number] => {
    const mappedStart = start(mark.start)
    const mappedEnd = mark.end === mark.start ? mappedStart : end(mark.end)
    const words = mark.visibleText
    if (
      words.length === 0 ||
      next.slice(mappedStart, mappedEnd) === words ||
      previous.slice(mark.start, mark.end) !== words
    ) {
      return [mappedStart, mappedEnd]
    }
    // Its words moved by between none and all of the edit's length change.
    const low = Math.min(mark.start, mark.start + delta)
    const high = Math.max(mark.start, mark.start + delta)
    const spanEnd = Math.max(mark.end, mark.end + delta, changedEnd + delta)
    let best = -1
    let bestDistance = Infinity
    for (
      let at = next.indexOf(words, Math.max(0, Math.min(low, prefix)));
      at !== -1 && at + words.length <= spanEnd;
      at = next.indexOf(words, at + 1)
    ) {
      const distance = at < low ? low - at : at > high ? at - high : 0
      if (distance < bestDistance) {
        best = at
        bestDistance = distance
      }
    }
    return best === -1 ? [mappedStart, mappedEnd] : [best, best + words.length]
  }

  let moved = false
  const rebased = marks.map((mark) => {
    const [nextStart, nextEnd] = place(mark)
    if (nextStart === mark.start && nextEnd === mark.end) return mark
    moved = true
    return { ...mark, start: nextStart, end: nextEnd }
  })
  return moved ? rebased : marks
}
