import type { CriticMarkupMark } from '@memry/shared'

/**
 * `marks` over `previous`, moved to where their text is in `next`, which is `previous` with one
 * range replaced (the editor's text after a change). The window owns an open note's marks in the
 * Y.Doc (#4425), so offsets left as they were would point at other text on every device, and
 * the serializer would move a comment to the first copy of its words.
 *
 * Text typed at a mark's edge stays out of it. A mark whose own text changed keeps its words,
 * and the serializer relocates or drops it as before. Returns `marks` itself when none moved.
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

  let moved = false
  const rebased = marks.map((mark) => {
    const nextStart = start(mark.start)
    const nextEnd = mark.end === mark.start ? nextStart : end(mark.end)
    if (nextStart === mark.start && nextEnd === mark.end) return mark
    moved = true
    return { ...mark, start: nextStart, end: nextEnd }
  })
  return moved ? rebased : marks
}
