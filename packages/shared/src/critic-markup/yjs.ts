import {
  normalizeCriticMarkupCommentAttachments,
  normalizeCriticMarkupCommentFormatRanges,
  normalizeCriticMarkupCommentMentions,
  type CriticMarkupKind,
  type CriticMarkupMark
} from './parser'

export const CRITIC_MARKUP_MARKS_ARRAY = 'criticMarkupMarks'

interface YArrayLike {
  length: number
  get(index: number): unknown
  toArray?: () => unknown[]
  delete(index: number, length: number): void
  push(values: unknown[]): void
}

interface YDocLike {
  getArray(name: string): YArrayLike
}

const VALID_KINDS = new Set<CriticMarkupKind>(['addition', 'deletion', 'substitution', 'comment'])

export function readCriticMarkupMarksFromYDoc(doc: YDocLike): CriticMarkupMark[] {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const values = array.toArray ? array.toArray() : readArrayLike(array)
  return values.flatMap((value) => {
    const mark = normalizeCriticMarkupMark(value)
    return mark ? [mark] : []
  })
}

export function writeCriticMarkupMarksToYDoc(doc: YDocLike, marks: CriticMarkupMark[]): void {
  const array = doc.getArray(CRITIC_MARKUP_MARKS_ARRAY)
  const next = marks.flatMap((mark) => {
    const normalized = normalizeCriticMarkupMark(mark)
    return normalized ? [toSerializableMark(normalized)] : []
  })
  const current = array.toArray ? array.toArray() : readArrayLike(array)
  if (JSON.stringify(current) === JSON.stringify(next)) return

  if (array.length > 0) array.delete(0, array.length)
  if (next.length > 0) array.push(next)
}

function readArrayLike(array: YArrayLike): unknown[] {
  const values: unknown[] = []
  for (let index = 0; index < array.length; index++) {
    values.push(array.get(index))
  }
  return values
}

function normalizeCriticMarkupMark(value: unknown): CriticMarkupMark | null {
  if (!value || typeof value !== 'object') return null
  const mark = value as Record<string, unknown>
  if (typeof mark.id !== 'string') return null
  if (typeof mark.kind !== 'string' || !VALID_KINDS.has(mark.kind as CriticMarkupKind)) {
    return null
  }
  if (typeof mark.visibleText !== 'string') return null
  if (typeof mark.start !== 'number' || typeof mark.end !== 'number') return null
  if (!Number.isFinite(mark.start) || !Number.isFinite(mark.end)) return null
  if (mark.start < 0 || mark.end < mark.start) return null

  const mentions = normalizeCriticMarkupCommentMentions(mark.mentions)
  const attachments = normalizeCriticMarkupCommentAttachments(mark.attachments)
  const formatRanges = normalizeCriticMarkupCommentFormatRanges(
    mark.formatRanges,
    (typeof mark.body === 'string' ? mark.body : '').trim().length
  )

  return {
    id: mark.id,
    kind: mark.kind as CriticMarkupKind,
    visibleText: mark.visibleText,
    start: mark.start,
    end: mark.end,
    ...(typeof mark.originalText === 'string' ? { originalText: mark.originalText } : {}),
    ...(typeof mark.body === 'string' ? { body: mark.body } : {}),
    ...(typeof mark.metadata === 'string' ? { metadata: mark.metadata } : {}),
    ...(typeof mark.createdAt === 'number' && Number.isFinite(mark.createdAt)
      ? { createdAt: mark.createdAt }
      : {}),
    ...(mentions ? { mentions } : {}),
    ...(attachments ? { attachments } : {}),
    ...(formatRanges ? { formatRanges } : {})
  }
}

function toSerializableMark(mark: CriticMarkupMark): Record<string, unknown> {
  return {
    id: mark.id,
    kind: mark.kind,
    visibleText: mark.visibleText,
    start: mark.start,
    end: mark.end,
    ...(mark.originalText !== undefined ? { originalText: mark.originalText } : {}),
    ...(mark.body !== undefined ? { body: mark.body } : {}),
    ...(mark.metadata !== undefined ? { metadata: mark.metadata } : {}),
    ...(mark.createdAt !== undefined ? { createdAt: mark.createdAt } : {}),
    ...(mark.mentions !== undefined ? { mentions: mark.mentions } : {}),
    ...(mark.attachments !== undefined ? { attachments: mark.attachments } : {}),
    ...(mark.formatRanges !== undefined ? { formatRanges: mark.formatRanges } : {})
  }
}
