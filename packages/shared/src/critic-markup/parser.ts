export type CriticMarkupKind = 'addition' | 'deletion' | 'substitution' | 'comment'

export type CriticMarkupCommentMentionKind =
  'note' | 'task' | 'journal' | 'inbox' | 'calendar_event'

export interface CriticMarkupCommentMentionRef {
  kind: CriticMarkupCommentMentionKind
  refId: string
  label: string
}

export interface CriticMarkupCommentAttachmentRef {
  id: string
  name: string
  path: string
  size?: number
  mimeType?: string
  type?: 'image' | 'file'
}

export type CriticMarkupCommentFormatMark =
  'bold' | 'italic' | 'underline' | 'strikethrough' | 'code'

/** Inline formatting for a slice of a comment body, as UTF-16 offsets into it. */
export interface CriticMarkupCommentFormatRange {
  start: number
  /** Exclusive. */
  end: number
  marks: CriticMarkupCommentFormatMark[]
}

export interface CriticMarkupMark {
  id: string
  kind: CriticMarkupKind
  visibleText: string
  start: number
  end: number
  originalText?: string
  body?: string
  metadata?: string
  createdAt?: number
  mentions?: CriticMarkupCommentMentionRef[]
  attachments?: CriticMarkupCommentAttachmentRef[]
  formatRanges?: CriticMarkupCommentFormatRange[]
}

export interface ParsedCriticMarkup {
  plainText: string
  marks: CriticMarkupMark[]
}

// A regex with lazy `[\s\S]*?` groups under the global flag re-scans to the end
// of the string at every unclosed `{` opener, giving O(n²) (polynomial ReDoS)
// parse time on adversarial note content. This hand-rolled single-pass scanner
// produces identical matches in O(n): each closing delimiter is searched with
// `indexOf` (forward-only) and, once a delimiter is known to be absent from the
// rest of the string, it is never searched again.
interface CriticMatch {
  index: number
  0: string
  [group: number]: string | undefined
}

const CRITIC_CLOSERS = {
  highlight: '==}',
  commentClose: '<<}',
  addition: '++}',
  deletion: '--}',
  substArrow: '~>',
  substClose: '~~}'
} as const

function* iterateCriticMarkupMatches(markdown: string): Generator<CriticMatch> {
  const exhausted = new Set<string>()
  const findClose = (closer: string, from: number): number => {
    if (exhausted.has(closer)) return -1
    const idx = markdown.indexOf(closer, from)
    if (idx === -1) exhausted.add(closer)
    return idx
  }
  const build = (index: number, full: string, groups: Record<number, string>): CriticMatch => {
    const match: CriticMatch = { index, 0: full }
    for (const key of Object.keys(groups)) match[Number(key)] = groups[Number(key)]
    return match
  }

  let i = 0
  const n = markdown.length
  while (i < n) {
    if (markdown[i] === '{') {
      // {==C1==}{>>C2<<}  — highlighted comment
      if (markdown.startsWith('{==', i)) {
        const c1 = findClose(CRITIC_CLOSERS.highlight, i + 3)
        if (c1 !== -1) {
          const after = c1 + 3
          if (markdown.startsWith('{>>', after)) {
            const c2 = findClose(CRITIC_CLOSERS.commentClose, after + 3)
            if (c2 !== -1) {
              const end = c2 + 3
              yield build(i, markdown.slice(i, end), {
                1: markdown.slice(i + 3, c1),
                2: markdown.slice(after + 3, c2)
              })
              i = end
              continue
            }
          }
        }
      } else if (markdown.startsWith('{++', i)) {
        const c = findClose(CRITIC_CLOSERS.addition, i + 3)
        if (c !== -1) {
          const end = c + 3
          yield build(i, markdown.slice(i, end), { 3: markdown.slice(i + 3, c) })
          i = end
          continue
        }
      } else if (markdown.startsWith('{--', i)) {
        const c = findClose(CRITIC_CLOSERS.deletion, i + 3)
        if (c !== -1) {
          const end = c + 3
          yield build(i, markdown.slice(i, end), { 4: markdown.slice(i + 3, c) })
          i = end
          continue
        }
      } else if (markdown.startsWith('{~~', i)) {
        const arrow = findClose(CRITIC_CLOSERS.substArrow, i + 3)
        if (arrow !== -1) {
          const close = findClose(CRITIC_CLOSERS.substClose, arrow + 2)
          if (close !== -1) {
            const end = close + 3
            yield build(i, markdown.slice(i, end), {
              5: markdown.slice(i + 3, arrow),
              6: markdown.slice(arrow + 2, close)
            })
            i = end
            continue
          }
        }
      } else if (markdown.startsWith('{>>', i)) {
        const c = findClose(CRITIC_CLOSERS.commentClose, i + 3)
        if (c !== -1) {
          const end = c + 3
          yield build(i, markdown.slice(i, end), { 7: markdown.slice(i + 3, c) })
          i = end
          continue
        }
      }
    }
    i++
  }
}

export function parseCriticMarkup(markdown: string): ParsedCriticMarkup {
  const marks: CriticMarkupMark[] = []
  let plainText = ''
  let lastIndex = 0

  for (const match of iterateCriticMarkupMatches(markdown)) {
    const matchText = match[0]
    const index = match.index ?? 0
    plainText += markdown.slice(lastIndex, index)
    const start = plainText.length

    if (match[1] !== undefined && match[2] !== undefined) {
      const visibleText = match[1]
      const payload = parseCommentPayload(match[2])
      plainText += visibleText
      marks.push({
        id: payload.id ?? fallbackMarkId('comment', start, visibleText, match[2]),
        kind: 'comment',
        visibleText,
        body: payload.body,
        metadata: payload.metadata,
        createdAt: payload.createdAt ?? createdAtFromCommentMarkId(payload.id),
        mentions: payload.mentions,
        attachments: payload.attachments,
        formatRanges: payload.formatRanges,
        start,
        end: plainText.length
      })
    } else if (match[3] !== undefined) {
      const visibleText = match[3]
      plainText += visibleText
      marks.push({
        id: fallbackMarkId('addition', start, visibleText),
        kind: 'addition',
        visibleText,
        start,
        end: plainText.length
      })
    } else if (match[4] !== undefined) {
      const visibleText = match[4]
      plainText += visibleText
      marks.push({
        id: fallbackMarkId('deletion', start, visibleText),
        kind: 'deletion',
        visibleText,
        originalText: visibleText,
        start,
        end: plainText.length
      })
    } else if (match[5] !== undefined && match[6] !== undefined) {
      const originalText = match[5]
      const visibleText = match[6]
      plainText += visibleText
      marks.push({
        id: fallbackMarkId('substitution', start, `${originalText}>${visibleText}`),
        kind: 'substitution',
        visibleText,
        originalText,
        start,
        end: plainText.length
      })
    } else if (match[7] !== undefined) {
      const payload = parseCommentPayload(match[7])
      marks.push({
        id: payload.id ?? fallbackMarkId('comment', start, '', match[7]),
        kind: 'comment',
        visibleText: '',
        body: payload.body,
        metadata: payload.metadata,
        createdAt: payload.createdAt ?? createdAtFromCommentMarkId(payload.id),
        mentions: payload.mentions,
        attachments: payload.attachments,
        formatRanges: payload.formatRanges,
        start,
        end: start
      })
    }

    lastIndex = index + matchText.length
  }

  plainText += markdown.slice(lastIndex)
  return { plainText, marks }
}

export function serializeCriticMarkup(plainText: string, marks: CriticMarkupMark[]): string {
  const ranges = marks
    .map((mark) => resolveMarkRange(plainText, mark))
    .filter((range): range is CriticMarkupMark => range !== null)
    .sort((a, b) => a.start - b.start)

  let result = ''
  let cursor = 0

  for (const mark of ranges) {
    if (mark.start < cursor) continue
    result += plainText.slice(cursor, mark.start)
    const visibleText = plainText.slice(mark.start, mark.end)
    result += serializeMark(mark, visibleText)
    cursor = mark.end
  }

  return result + plainText.slice(cursor)
}

export function buildCommentPayload(
  mark: Pick<
    CriticMarkupMark,
    'id' | 'body' | 'metadata' | 'mentions' | 'attachments' | 'formatRanges'
  >
) {
  const body = mark.body ?? ''
  const metadata = buildCommentMetadata(mark, body)
  return `${metadata} | ${body}`
}

export function normalizeCriticMarkupCommentMentions(
  value: unknown
): CriticMarkupCommentMentionRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const mentions = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const mention = item as Record<string, unknown>
    if (!isCriticMarkupCommentMentionKind(mention.kind)) return []
    if (typeof mention.refId !== 'string' || mention.refId.length === 0) return []
    if (typeof mention.label !== 'string' || mention.label.length === 0) return []
    return [
      {
        kind: mention.kind,
        refId: mention.refId,
        label: mention.label
      }
    ]
  })
  return mentions.length > 0 ? mentions : undefined
}

export function normalizeCriticMarkupCommentAttachments(
  value: unknown
): CriticMarkupCommentAttachmentRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  const attachments = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const attachment = item as Record<string, unknown>
    if (typeof attachment.id !== 'string' || attachment.id.length === 0) return []
    if (typeof attachment.name !== 'string' || attachment.name.length === 0) return []
    if (typeof attachment.path !== 'string' || attachment.path.length === 0) return []

    const normalized: CriticMarkupCommentAttachmentRef = {
      id: attachment.id,
      name: attachment.name,
      path: attachment.path
    }
    if (typeof attachment.size === 'number' && Number.isFinite(attachment.size)) {
      normalized.size = attachment.size
    }
    if (typeof attachment.mimeType === 'string') normalized.mimeType = attachment.mimeType
    if (attachment.type === 'image' || attachment.type === 'file') {
      normalized.type = attachment.type
    }
    return [normalized]
  })
  return attachments.length > 0 ? attachments : undefined
}

/** Canonical mark order. Also the outermost-first nesting order when rendered. */
export const CRITIC_MARKUP_COMMENT_FORMAT_MARKS: CriticMarkupCommentFormatMark[] = [
  'bold',
  'italic',
  'underline',
  'strikethrough',
  'code'
]

const COMMENT_FORMAT_VERSION = 1

/**
 * Fingerprints the body the ranges were measured against. Offsets desync when
 * the body is edited outside the app (another client, Obsidian, a hand edit);
 * a mismatch drops the formatting instead of painting it over the wrong words.
 */
export function criticMarkupCommentBodyHash(body: string): string {
  return hash(body.trim())
}

export function normalizeCriticMarkupCommentFormatRanges(
  value: unknown,
  bodyLength: number
): CriticMarkupCommentFormatRange[] | undefined {
  if (!Array.isArray(value)) return undefined
  const ranges = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const range = item as Record<string, unknown>
    const start = range.start
    const end = range.end
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) return []
    if (typeof end !== 'number' || !Number.isFinite(end) || end <= start) return []
    if (start >= bodyLength) return []

    const marks = normalizeCommentFormatMarks(range.marks)
    if (marks.length === 0) return []
    return [{ start, end: Math.min(end, bodyLength), marks }]
  })

  // Canonical order: `areCriticMarkupMarksEqual` and the Y.Doc writer both
  // compare marks by JSON.stringify, so an unstable order reads as a change.
  ranges.sort((a, b) => a.start - b.start || a.end - b.end)
  return ranges.length > 0 ? ranges : undefined
}

export function parseCriticMarkupCommentFormat(
  encoded: string | undefined,
  body: string
): CriticMarkupCommentFormatRange[] | undefined {
  if (!encoded) return undefined
  try {
    const payload = JSON.parse(decodeURIComponent(encoded)) as Record<string, unknown>
    if (!payload || typeof payload !== 'object') return undefined
    if (payload.v !== COMMENT_FORMAT_VERSION) return undefined
    if (payload.hash !== criticMarkupCommentBodyHash(body)) return undefined
    return normalizeCriticMarkupCommentFormatRanges(payload.ranges, body.length)
  } catch {
    return undefined
  }
}

function normalizeCommentFormatMarks(value: unknown): CriticMarkupCommentFormatMark[] {
  if (!Array.isArray(value)) return []
  const marks = new Set<CriticMarkupCommentFormatMark>()
  for (const mark of value) {
    if (isCriticMarkupCommentFormatMark(mark)) marks.add(mark)
  }
  return CRITIC_MARKUP_COMMENT_FORMAT_MARKS.filter((mark) => marks.has(mark))
}

function isCriticMarkupCommentFormatMark(value: unknown): value is CriticMarkupCommentFormatMark {
  return (
    value === 'bold' ||
    value === 'italic' ||
    value === 'underline' ||
    value === 'strikethrough' ||
    value === 'code'
  )
}

function serializeMark(mark: CriticMarkupMark, visibleText: string): string {
  switch (mark.kind) {
    case 'addition':
      return `{++${visibleText}++}`
    case 'deletion':
      return `{--${visibleText}--}`
    case 'substitution':
      return `{~~${mark.originalText ?? ''}~>${visibleText}~~}`
    case 'comment':
      return `{==${visibleText}==}{>>${buildCommentPayload(mark)}<<}`
  }
}

function resolveMarkRange(plainText: string, mark: CriticMarkupMark): CriticMarkupMark | null {
  if (
    mark.start >= 0 &&
    mark.end >= mark.start &&
    plainText.slice(mark.start, mark.end) === mark.visibleText
  ) {
    return mark
  }

  if (mark.visibleText.length === 0) return mark
  if (mark.kind !== 'comment') return null

  const nextStart = plainText.indexOf(mark.visibleText)
  if (nextStart === -1) return null
  return {
    ...mark,
    start: nextStart,
    end: nextStart + mark.visibleText.length
  }
}

function parseCommentPayload(payload: string): {
  id?: string
  metadata?: string
  body: string
  createdAt?: number
  mentions?: CriticMarkupCommentMentionRef[]
  attachments?: CriticMarkupCommentAttachmentRef[]
  formatRanges?: CriticMarkupCommentFormatRange[]
} {
  const separator = payload.indexOf(' | ')
  const metadata = separator === -1 ? undefined : payload.slice(0, separator).trim()
  const body = separator === -1 ? payload.trim() : payload.slice(separator + 3).trim()
  const fields = metadata ? parseMetadataFields(metadata) : new Map<string, string>()
  const id = fields.get('id')
  return {
    id,
    metadata,
    body,
    createdAt: parseCommentCreatedAt(fields.get('createdAt')),
    mentions: parseStructuredCommentMetadata(
      fields.get('mentions'),
      normalizeCriticMarkupCommentMentions
    ),
    attachments: parseStructuredCommentMetadata(
      fields.get('attachments'),
      normalizeCriticMarkupCommentAttachments
    ),
    formatRanges: parseCriticMarkupCommentFormat(fields.get('format'), body)
  }
}

function buildCommentMetadata(
  mark: Pick<CriticMarkupMark, 'id' | 'metadata' | 'mentions' | 'attachments' | 'formatRanges'>,
  body: string
): string {
  const metadata = mark.metadata?.trim() || `id=${mark.id};type=comment`
  const hasMentionInput = Array.isArray(mark.mentions)
  const hasAttachmentInput = Array.isArray(mark.attachments)
  const hasFormatInput = Array.isArray(mark.formatRanges)
  if (!hasMentionInput && !hasAttachmentInput && !hasFormatInput) return metadata

  const parts = metadata
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf('=')
      if (separator <= 0) return part.length > 0
      const key = part.slice(0, separator)
      return key !== 'mentions' && key !== 'attachments' && key !== 'format'
    })

  const mentions = normalizeCriticMarkupCommentMentions(mark.mentions)
  const attachments = normalizeCriticMarkupCommentAttachments(mark.attachments)
  const trimmedBody = body.trim()
  const formatRanges = normalizeCriticMarkupCommentFormatRanges(
    mark.formatRanges,
    trimmedBody.length
  )
  if (mentions) parts.push(`mentions=${encodeURIComponent(JSON.stringify(mentions))}`)
  if (attachments) parts.push(`attachments=${encodeURIComponent(JSON.stringify(attachments))}`)
  // Last, so comments without formatting serialize byte-identically to before.
  if (formatRanges) {
    const payload = {
      v: COMMENT_FORMAT_VERSION,
      hash: criticMarkupCommentBodyHash(trimmedBody),
      ranges: formatRanges
    }
    parts.push(`format=${encodeURIComponent(JSON.stringify(payload))}`)
  }
  return parts.join(';') || `id=${mark.id};type=comment`
}

function parseCommentCreatedAt(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

// Comment ids created in the composer embed the creation time as base36
// (`critic-comment-<Date.now().toString(36)>-<random>`); recover it for
// comments saved before createdAt landed in metadata.
const COMMENT_ID_TIMESTAMP_PATTERN = /^critic-comment-([0-9a-z]+)-/
const COMMENT_ID_TIMESTAMP_MIN = Date.UTC(2020, 0, 1)
const COMMENT_ID_TIMESTAMP_MAX = Date.UTC(2100, 0, 1)

function createdAtFromCommentMarkId(id: string | undefined): number | undefined {
  const match = id ? COMMENT_ID_TIMESTAMP_PATTERN.exec(id) : null
  if (!match) return undefined
  const parsed = parseInt(match[1], 36)
  return parsed >= COMMENT_ID_TIMESTAMP_MIN && parsed < COMMENT_ID_TIMESTAMP_MAX
    ? parsed
    : undefined
}

function parseMetadataFields(metadata: string): Map<string, string> {
  const fields = new Map<string, string>()
  metadata.split(';').forEach((part) => {
    const separator = part.indexOf('=')
    if (separator <= 0) return
    fields.set(part.slice(0, separator), part.slice(separator + 1))
  })
  return fields
}

function parseStructuredCommentMetadata<T>(
  encoded: string | undefined,
  normalize: (value: unknown) => T[] | undefined
): T[] | undefined {
  if (!encoded) return undefined
  try {
    return normalize(JSON.parse(decodeURIComponent(encoded)))
  } catch {
    return undefined
  }
}

function isCriticMarkupCommentMentionKind(kind: unknown): kind is CriticMarkupCommentMentionKind {
  return (
    kind === 'note' ||
    kind === 'task' ||
    kind === 'journal' ||
    kind === 'inbox' ||
    kind === 'calendar_event'
  )
}

function fallbackMarkId(
  kind: CriticMarkupKind,
  start: number,
  visibleText: string,
  extra = ''
): string {
  return `critic-${kind}-${start}-${hash(`${visibleText}:${extra}`)}`
}

function hash(value: string): string {
  let result = 5381
  for (let index = 0; index < value.length; index++) {
    result = (result * 33) ^ value.charCodeAt(index)
  }
  return (result >>> 0).toString(36)
}
