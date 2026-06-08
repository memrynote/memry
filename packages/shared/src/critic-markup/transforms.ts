import type { CriticMarkupMark } from './parser'

interface TransformResult {
  plainText: string
  marks: CriticMarkupMark[]
}

export function acceptCriticMark(
  plainText: string,
  marks: CriticMarkupMark[],
  id: string
): TransformResult {
  const mark = marks.find((item) => item.id === id)
  if (!mark) return { plainText, marks }

  if (mark.kind === 'deletion') {
    return removeVisibleRange(plainText, marks, mark)
  }

  return {
    plainText,
    marks: marks.filter((item) => item.id !== id)
  }
}

export function rejectCriticMark(
  plainText: string,
  marks: CriticMarkupMark[],
  id: string
): TransformResult {
  const mark = marks.find((item) => item.id === id)
  if (!mark) return { plainText, marks }

  if (mark.kind === 'addition') {
    return removeVisibleRange(plainText, marks, mark)
  }

  if (mark.kind === 'substitution') {
    const before = plainText.slice(0, mark.start)
    const after = plainText.slice(mark.end)
    const replacement = mark.originalText ?? ''
    return {
      plainText: `${before}${replacement}${after}`,
      marks: shiftMarks(
        marks.filter((item) => item.id !== id),
        mark.end,
        replacement.length - (mark.end - mark.start)
      )
    }
  }

  return {
    plainText,
    marks: marks.filter((item) => item.id !== id)
  }
}

export function resolveCriticMark(
  plainText: string,
  marks: CriticMarkupMark[],
  id: string
): TransformResult {
  return {
    plainText,
    marks: marks.filter((item) => item.id !== id)
  }
}

export function deleteCriticMark(
  plainText: string,
  marks: CriticMarkupMark[],
  id: string
): TransformResult {
  return resolveCriticMark(plainText, marks, id)
}

function removeVisibleRange(
  plainText: string,
  marks: CriticMarkupMark[],
  mark: CriticMarkupMark
): TransformResult {
  const before = plainText.slice(0, mark.start)
  const after = plainText.slice(mark.end)
  const delta = mark.start - mark.end
  return {
    plainText: `${before}${after}`,
    marks: shiftMarks(
      marks.filter((item) => item.id !== mark.id),
      mark.end,
      delta
    )
  }
}

function shiftMarks(
  marks: CriticMarkupMark[],
  changeEnd: number,
  delta: number
): CriticMarkupMark[] {
  if (delta === 0) return marks
  return marks.map((mark) => {
    if (mark.start < changeEnd) return mark
    return {
      ...mark,
      start: mark.start + delta,
      end: mark.end + delta
    }
  })
}
