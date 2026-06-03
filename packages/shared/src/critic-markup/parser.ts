export type CriticMarkupKind = 'addition' | 'deletion' | 'substitution' | 'comment'

export type CriticMarkupCommentMentionKind =
  | 'note'
  | 'task'
  | 'journal'
  | 'inbox'
  | 'calendar_event'

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

export interface CriticMarkupMark {
  id: string
  kind: CriticMarkupKind
  visibleText: string
  start: number
  end: number
  originalText?: string
  body?: string
  metadata?: string
  mentions?: CriticMarkupCommentMentionRef[]
  attachments?: CriticMarkupCommentAttachmentRef[]
}

export interface ParsedCriticMarkup {
  plainText: string
  marks: CriticMarkupMark[]
}

const CRITIC_MARKUP_PATTERN =
  /\{==([\s\S]*?)==\}\{>>([\s\S]*?)<<\}|\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{>>([\s\S]*?)<<\}/g

export function parseCriticMarkup(markdown: string): ParsedCriticMarkup {
  const marks: CriticMarkupMark[] = []
  let plainText = ''
  let lastIndex = 0

  for (const match of markdown.matchAll(CRITIC_MARKUP_PATTERN)) {
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
        mentions: payload.mentions,
        attachments: payload.attachments,
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
        mentions: payload.mentions,
        attachments: payload.attachments,
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
  mark: Pick<CriticMarkupMark, 'id' | 'body' | 'metadata' | 'mentions' | 'attachments'>
) {
  const metadata = buildCommentMetadata(mark)
  const body = mark.body ?? ''
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
  mentions?: CriticMarkupCommentMentionRef[]
  attachments?: CriticMarkupCommentAttachmentRef[]
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
    mentions: parseStructuredCommentMetadata(
      fields.get('mentions'),
      normalizeCriticMarkupCommentMentions
    ),
    attachments: parseStructuredCommentMetadata(
      fields.get('attachments'),
      normalizeCriticMarkupCommentAttachments
    )
  }
}

function buildCommentMetadata(
  mark: Pick<CriticMarkupMark, 'id' | 'metadata' | 'mentions' | 'attachments'>
): string {
  const metadata = mark.metadata?.trim() || `id=${mark.id};type=comment`
  const hasMentionInput = Array.isArray(mark.mentions)
  const hasAttachmentInput = Array.isArray(mark.attachments)
  if (!hasMentionInput && !hasAttachmentInput) return metadata

  const parts = metadata
    .split(';')
    .map((part) => part.trim())
    .filter((part) => {
      const separator = part.indexOf('=')
      if (separator <= 0) return part.length > 0
      const key = part.slice(0, separator)
      return key !== 'mentions' && key !== 'attachments'
    })

  const mentions = normalizeCriticMarkupCommentMentions(mark.mentions)
  const attachments = normalizeCriticMarkupCommentAttachments(mark.attachments)
  if (mentions) parts.push(`mentions=${encodeURIComponent(JSON.stringify(mentions))}`)
  if (attachments) parts.push(`attachments=${encodeURIComponent(JSON.stringify(attachments))}`)
  return parts.join(';') || `id=${mark.id};type=comment`
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
