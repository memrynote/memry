import type { CriticMarkupKind, CriticMarkupMark } from '@memry/shared'
import type { AddSuggestionMarkInput } from './use-critic-markup-review'

export function reconcileLiveSuggestionEdit(
  previousPlainMarkdown: string,
  nextPlainMarkdown: string,
  marks: CriticMarkupMark[]
): { marks: CriticMarkupMark[]; changedMarkId?: string } {
  const edit = findSingleTextEdit(previousPlainMarkdown, nextPlainMarkdown)
  if (!edit) return { marks }

  const insertedVisibleText = stripTrailingBlockSeparators(edit.insertedText)
  const sourceDelta = edit.insertedText.length - edit.deletedText.length
  const visibleDelta = insertedVisibleText.length - edit.deletedText.length
  const editEnd = edit.start + edit.deletedText.length

  // Pure block-separator changes (Enter splits, empty-block gap re-encoding by
  // the serializer) move text without adding visible content. They must SHIFT
  // marks — never extend a mark's visibleText over newlines (additions cannot
  // span block breaks; serializeCriticMarkup would silently drop them).
  if (isNewlineOnly(edit.insertedText) && !edit.deletedText) {
    const length = edit.insertedText.length
    const splitTarget = marks.find(
      (mark) => mark.kind === 'addition' && mark.start < edit.start && edit.start < mark.end
    )
    if (splitTarget) {
      // Enter pressed inside an addition: split it into two additions.
      const reconciledMarks = marks.flatMap((mark) => {
        if (mark.id !== splitTarget.id) {
          return [shiftMarkForPlainTextEdit(mark, edit.start, edit.start, length)]
        }
        const firstText = nextPlainMarkdown.slice(mark.start, edit.start)
        const secondStart = edit.start + length
        const secondEnd = mark.end + length
        const secondText = nextPlainMarkdown.slice(secondStart, secondEnd)
        const parts: CriticMarkupMark[] = []
        if (firstText.trim()) parts.push({ ...mark, end: edit.start, visibleText: firstText })
        if (secondText.trim()) {
          parts.push({
            ...mark,
            id: createCriticMarkId('addition'),
            start: secondStart,
            end: secondEnd,
            visibleText: secondText
          })
        }
        return parts
      })
      return { marks: reconciledMarks, changedMarkId: splitTarget.id }
    }
    return { marks: shiftMarksForPlainTextEdit(marks, edit.start, edit.start, length) }
  }
  if (isNewlineOnly(edit.deletedText) && !edit.insertedText) {
    return {
      marks: shiftMarksForPlainTextEdit(marks, edit.start, editEnd, -edit.deletedText.length)
    }
  }

  const targetAddition = [...marks]
    .reverse()
    .find(
      (mark) =>
        mark.kind === 'addition' &&
        mark.start <= edit.start &&
        mark.end >= edit.start &&
        editEnd <= mark.end
    )

  if (targetAddition) {
    const reconciledMarks = marks.flatMap((mark) => {
      if (mark.id !== targetAddition.id) {
        return shiftMarkForPlainTextEdit(mark, edit.start, editEnd, sourceDelta)
      }

      const end = mark.end + visibleDelta
      const visibleText = nextPlainMarkdown.slice(mark.start, end)
      if (!visibleText.trim()) return []
      return [
        {
          ...mark,
          end,
          visibleText
        }
      ]
    })
    return { marks: reconciledMarks, changedMarkId: targetAddition.id }
  }

  if (!edit.insertedText || edit.deletedText) return { marks }

  const shiftedMarks = shiftMarksForPlainTextEdit(
    marks,
    edit.start,
    edit.start,
    edit.insertedText.length
  )
  if (!insertedVisibleText.trim()) return { marks: shiftedMarks }

  const id = createCriticMarkId('addition')
  return {
    marks: [
      ...shiftedMarks,
      {
        id,
        kind: 'addition',
        visibleText: insertedVisibleText,
        createdAt: Date.now(),
        start: edit.start,
        end: edit.start + visibleDelta
      }
    ],
    changedMarkId: id
  }
}

function stripTrailingBlockSeparators(text: string): string {
  return text.replace(/\n+$/u, '')
}

function isNewlineOnly(text: string): boolean {
  return text.length > 0 && /^\n+$/u.test(text)
}

export function findSingleTextEdit(
  previousText: string,
  nextText: string
): { start: number; deletedText: string; insertedText: string } | null {
  if (previousText === nextText) return null

  let start = 0
  while (
    start < previousText.length &&
    start < nextText.length &&
    previousText[start] === nextText[start]
  ) {
    start++
  }

  let previousEnd = previousText.length
  let nextEnd = nextText.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previousText[previousEnd - 1] === nextText[nextEnd - 1]
  ) {
    previousEnd--
    nextEnd--
  }

  return {
    start,
    deletedText: previousText.slice(start, previousEnd),
    insertedText: nextText.slice(start, nextEnd)
  }
}

export function mergeAdjacentDeletionMark(
  marks: CriticMarkupMark[],
  input: AddSuggestionMarkInput,
  start: number
): CriticMarkupMark[] | null {
  const visibleText = input.visibleText
  const originalText = input.originalText ?? input.visibleText
  const end = start + visibleText.length

  // The adjacent deletion is not necessarily the LAST mark — the user may
  // have made other suggestions in between, jumped the cursor away, and
  // returned. Search every deletion mark; backspace moves end-to-start, so
  // prefer prepending to a mark that starts where this deletion ends.
  const prependTarget = marks.find((mark) => mark.kind === 'deletion' && mark.start === end)
  if (prependTarget) {
    return marks.map((mark) =>
      mark.id === prependTarget.id
        ? {
            ...mark,
            visibleText: `${visibleText}${mark.visibleText}`,
            originalText: `${originalText}${mark.originalText ?? mark.visibleText}`,
            start,
            end: mark.end
          }
        : mark
    )
  }

  const appendTarget = marks.find((mark) => mark.kind === 'deletion' && mark.end === start)
  if (appendTarget) {
    return marks.map((mark) =>
      mark.id === appendTarget.id
        ? {
            ...mark,
            visibleText: `${mark.visibleText}${visibleText}`,
            originalText: `${mark.originalText ?? mark.visibleText}${originalText}`,
            end
          }
        : mark
    )
  }

  return null
}

export function shiftMarksForPlainTextEdit(
  marks: CriticMarkupMark[],
  editStart: number,
  editEnd: number,
  delta: number
): CriticMarkupMark[] {
  if (delta === 0) return marks
  return marks.map((mark) => shiftMarkForPlainTextEdit(mark, editStart, editEnd, delta))
}

function shiftMarkForPlainTextEdit(
  mark: CriticMarkupMark,
  editStart: number,
  editEnd: number,
  delta: number
): CriticMarkupMark {
  if (delta === 0) return mark
  if (mark.end <= editStart) return mark
  if (mark.start >= editEnd) {
    return {
      ...mark,
      start: mark.start + delta,
      end: mark.end + delta
    }
  }
  return {
    ...mark,
    end: mark.end + delta
  }
}

export function createCriticMarkId(kind: CriticMarkupKind): string {
  return `critic-${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
