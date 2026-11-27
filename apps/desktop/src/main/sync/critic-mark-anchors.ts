/**
 * Moves review marks with the text they cover, at write-back.
 *
 * A mark in the doc's `criticMarkupMarks` is a pair of offsets into the note's
 * text, and the text moves under it as the note is edited. The file the last
 * pass wrote holds each mark at the exact place it covered then. So the pass
 * diffs that file's text against the doc's text now and carries each mark
 * through the diff: an edit before a mark shifts it, an edit inside it grows
 * or shrinks it, and two marks on the same word stay on their own copies.
 *
 * The write-back is the one owner of this. It is the only code that sees both
 * the text the marks were placed in (the file) and the text they must be
 * placed in now (the doc), for this device's edits and every other device's.
 * The persisted shapes do not change: the doc gets the moved offsets, and the
 * file gets the marks where they now are.
 */
import { diffChars } from 'diff'
import type * as Y from 'yjs'
import {
  decodeWritingMarkers,
  parseCriticMarkup,
  placeCriticMarkupMarks,
  readCriticMarkupMarksFromYDoc,
  updateCriticMarkupMarksInYDoc,
  withoutWritingSentinels,
  type CriticMarkupMark
} from '@memry/shared'

/** A doc mark as the doc holds it, and where the body now places it. */
export interface CriticMarkMove {
  before: CriticMarkupMark
  after: CriticMarkupMark
}

export interface CriticMarkAnchors {
  /** The marks the body carries, positioned in its text. */
  placed: CriticMarkupMark[]
  moves: CriticMarkMove[]
  /** Comments whose every word was deleted since the file: kept as a point where they were. */
  orphaned: string[]
  /** Marks the body cannot carry: their text is gone, or another mark covers it. */
  unplaced: string[]
}

/** Past this, a diff gives up and the marks it covers fall back to their text. */
const DIFF_TIMEOUT_MS = 200

/**
 * Where each of the doc's `marks` goes in `plain`, the body's text now.
 * `previousBody` is the body of the file the last pass wrote, null when there
 * is none; a mark it holds is carried from there through the edit.
 *
 * A mark the file holds is carried when the doc still has it where the file
 * put it, or when the doc's copy no longer matches the text. A doc copy that
 * differs and still matches was moved since by another pass, here or on
 * another device, and is kept: two devices then never undo each other.
 */
export function anchorCriticMarks(
  marks: CriticMarkupMark[],
  plain: string,
  previousBody: string | null
): CriticMarkAnchors {
  const previous = previousBody === null ? null : marksInFile(previousBody)
  let hunks: Hunk[] | null = null
  const orphaned: string[] = []
  const carried = marks.map((mark) => {
    const old = previous && fileCopy(previous, mark)
    if (!previous || !old || (!sameRange(old, mark) && holdsText(plain, mark))) return mark
    hunks ??= diffHunks(previous.text, plain)
    const moved = carry(mark, old, hunks, plain)
    if (!moved) return mark
    if (moved.visibleText === '' && old.visibleText !== '') {
      // A suggestion with no text left has nothing to suggest; it stays out
      // of the file as before. A comment keeps its thread.
      if (mark.kind !== 'comment') return mark
      orphaned.push(mark.id)
    }
    return moved
  })

  const { placed, unplaced } = placeCriticMarkupMarks(plain, carried)
  const before = new Map(marks.map((mark) => [mark.id, mark]))
  const moves = placed.flatMap((after) => {
    const mark = before.get(after.id)
    return mark && !sameRange(mark, after) ? [{ before: mark, after }] : []
  })
  return { placed, moves, orphaned, unplaced: unplaced.map((mark) => mark.id) }
}

/**
 * Puts the moved marks in `doc`, in one transaction. A mark whose doc copy
 * changed since the pass read it (an edit to the comment, a move from another
 * device) is left alone; the next pass places it again. Resolves how many
 * marks moved.
 */
export function applyCriticMarkMoves(doc: Y.Doc, moves: CriticMarkMove[]): number {
  if (moves.length === 0) return 0
  const current = new Map(readCriticMarkupMarksFromYDoc(doc).map((mark) => [mark.id, mark]))
  const upsert = moves.flatMap(({ before, after }) => {
    const mark = current.get(before.id)
    return mark && JSON.stringify(mark) === JSON.stringify(before) ? [after] : []
  })
  if (upsert.length > 0) updateCriticMarkupMarksInYDoc(doc, { upsert })
  return upsert.length
}

function sameRange(a: CriticMarkupMark, b: CriticMarkupMark): boolean {
  return a.start === b.start && a.end === b.end && a.visibleText === b.visibleText
}

function holdsText(plain: string, mark: CriticMarkupMark): boolean {
  return plain.slice(mark.start, mark.end) === mark.visibleText
}

/** The file's text as every CriticMarkup reader counts it, and its marks. */
function marksInFile(body: string): { text: string; marks: CriticMarkupMark[] } {
  const decoded = decodeWritingMarkers(body.replace(/\r\n?/g, '\n'))
  const parsed = withoutWritingSentinels(parseCriticMarkup(decoded.text), decoded.sentinels)
  return { text: parsed.plainText, marks: parsed.marks }
}

/**
 * The file's copy of `mark`: the one with its id, or else the one of its kind
 * where the doc has it. A suggestion, and a comment written without an id, is
 * named by where it stood when the file was read into the doc, so once it
 * moves the file names it differently from the doc.
 *
 * A mark added since the file was written is not in it yet, and its words can
 * be edited before the pass that writes it: its offsets then count in the
 * file's text, which is the text it was added to when it covers its words
 * there.
 */
function fileCopy(
  file: { text: string; marks: CriticMarkupMark[] },
  mark: CriticMarkupMark
): CriticMarkupMark | null {
  return (
    file.marks.find((old) => old.id === mark.id) ??
    file.marks.find((old) => old.kind === mark.kind && sameRange(old, mark)) ??
    (holdsText(file.text, mark) ? mark : null)
  )
}

/** `mark`, at the place the edit took the file's copy `old` to; null when the diff cannot tell. */
function carry(
  mark: CriticMarkupMark,
  old: CriticMarkupMark,
  hunks: Hunk[],
  plain: string
): CriticMarkupMark | null {
  const start = mapOffset(hunks, old.start, 'start')
  const end = old.end === old.start ? start : mapOffset(hunks, old.end, 'end')
  if (start === null || end === null) return null
  if (end <= start) {
    const point = Math.min(start, end)
    return { ...mark, start: point, end: point, visibleText: '' }
  }
  const visibleText = plain.slice(start, end)
  return {
    ...mark,
    start,
    end,
    visibleText,
    // The parser reads a deletion's text as its original text too.
    ...(mark.kind === 'deletion' ? { originalText: visibleText } : {})
  }
}

/** One changed region: old text `[oldStart, oldEnd)` became new text `[newStart, newEnd)`. */
interface Hunk {
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  /** The diff gave up here: nothing inside it can be placed by offset. */
  opaque?: boolean
  /**
   * For a pure insertion or deletion, every old offset it could start at and
   * give the same new text: typing `. Omega` after `zeta.` is also typing
   * `a. Omeg` inside `zeta`, and the diff may report either.
   */
  slide?: { from: number; to: number }
}

/**
 * Where an offset in the old text lands in the new one. A mark's ends do not
 * take in text inserted right at them, and take in what replaced their own
 * first or last characters. An end inside a deleted run goes to the edge of
 * what replaced it on the mark's side, so a mark whose text was all deleted
 * closes to a point.
 */
function mapOffset(hunks: Hunk[], offset: number, side: 'start' | 'end'): number | null {
  let shift = 0
  for (const hunk of hunks) {
    const slid = mapAcrossSlide(hunk, offset, side, shift)
    if (slid !== null) return slid
    if (hunk.oldEnd < offset) {
      shift = hunk.newEnd - hunk.oldEnd
      continue
    }
    if (hunk.oldStart > offset) break
    if (hunk.oldStart === hunk.oldEnd) return side === 'start' ? hunk.newEnd : hunk.newStart
    if (offset === hunk.oldStart) return hunk.newStart
    if (offset === hunk.oldEnd) return hunk.newEnd
    if (hunk.opaque) return null
    return side === 'start' ? hunk.newEnd : hunk.newStart
  }
  return offset + shift
}

/**
 * `offset` when `hunk` can slide to start or end right at it: the edit then
 * goes on the outer side of the mark's end, so the mark keeps its own text.
 * Null when it cannot.
 */
function mapAcrossSlide(
  hunk: Hunk,
  offset: number,
  side: 'start' | 'end',
  shift: number
): number | null {
  if (!hunk.slide) return null
  const removed = hunk.oldEnd - hunk.oldStart
  const added = hunk.newEnd - hunk.newStart
  const startsAt = offset >= hunk.slide.from && offset <= hunk.slide.to
  const endsAt = offset - removed >= hunk.slide.from && offset - removed <= hunk.slide.to
  if (!startsAt && !endsAt) return null
  const editBefore = side === 'start' ? endsAt : !startsAt
  return editBefore ? offset - removed + added + shift : offset + shift
}

/**
 * The regions that differ between two texts, in order.
 */
function diffHunks(oldText: string, newText: string): Hunk[] {
  const shortest = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < shortest && oldText[prefix] === newText[prefix]) prefix++
  let suffix = 0
  while (
    suffix < shortest - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix++
  }
  const oldEnd = oldText.length - suffix
  const newEnd = newText.length - suffix
  if (prefix === oldEnd && prefix === newEnd) return []

  const changes = diffChars(oldText.slice(prefix, oldEnd), newText.slice(prefix, newEnd), {
    timeout: DIFF_TIMEOUT_MS
  })
  if (!changes) return [{ oldStart: prefix, oldEnd, newStart: prefix, newEnd, opaque: true }]

  const hunks: Hunk[] = []
  let oldAt = prefix
  let newAt = prefix
  let open: Hunk | null = null
  for (const change of changes) {
    const length = change.value.length
    if (!change.added && !change.removed) {
      open = null
      oldAt += length
      newAt += length
      continue
    }
    if (!open) {
      open = { oldStart: oldAt, oldEnd: oldAt, newStart: newAt, newEnd: newAt }
      hunks.push(open)
    }
    if (change.removed) open.oldEnd = oldAt += length
    else open.newEnd = newAt += length
  }

  hunks.forEach((hunk, index) => {
    hunk.slide = slideOf(
      hunk,
      oldText,
      newText,
      hunks[index - 1]?.oldEnd ?? 0,
      hunks[index + 1]?.oldStart ?? oldText.length
    )
  })
  return hunks
}

/** `Hunk.slide`, within the unchanged old text `[left, right)` around the hunk. */
function slideOf(
  hunk: Hunk,
  oldText: string,
  newText: string,
  left: number,
  right: number
): Hunk['slide'] {
  const removed = hunk.oldEnd - hunk.oldStart
  if (hunk.opaque || (removed > 0 && hunk.newEnd > hunk.newStart)) return undefined
  let from = hunk.oldStart
  let to = hunk.oldStart
  if (removed > 0) {
    while (from > left && oldText[from - 1] === oldText[from - 1 + removed]) from--
    while (to + removed < right && oldText[to] === oldText[to + removed]) to++
    return { from, to }
  }
  let piece = newText.slice(hunk.newStart, hunk.newEnd)
  while (from > left && oldText[from - 1] === piece.at(-1)) {
    piece = oldText[--from] + piece.slice(0, -1)
  }
  piece = newText.slice(hunk.newStart, hunk.newEnd)
  while (to < right && oldText[to] === piece[0]) {
    piece = piece.slice(1) + oldText[to++]
  }
  return { from, to }
}
