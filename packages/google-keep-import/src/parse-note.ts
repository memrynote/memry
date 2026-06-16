import type { KeepNote, KeepLabel, KeepAttachment, KeepListItem } from './types.ts'

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function parseLabels(raw: unknown): KeepLabel[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (typeof item === 'string') return [{ name: item }]
    if (isRecord(item) && typeof item['name'] === 'string') return [{ name: item['name'] }]
    return []
  })
}

function parseAttachments(raw: unknown): KeepAttachment[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!isRecord(item)) return []
    const filePath = item['filePath']
    const mimetype = item['mimetype']
    if (typeof filePath !== 'string' || typeof mimetype !== 'string') return []
    return [{ filePath, mimetype }]
  })
}

function parseListContent(raw: unknown): KeepListItem[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((item) => {
    if (!isRecord(item)) return []
    const text = item['text']
    const isChecked = item['isChecked']
    if (typeof text !== 'string') return []
    return [{ text, isChecked: isChecked === true }]
  })
}

/**
 * Validates and normalises one raw JSON object into a KeepNote.
 * Returns null if the object doesn't look like a Keep note.
 */
export function parseKeepNote(raw: unknown): KeepNote | null {
  if (!isRecord(raw)) return null

  const createdTimestampUsec = raw['createdTimestampUsec']
  const userEditedTimestampUsec = raw['userEditedTimestampUsec']

  // These fields are the strongest signal that this is a Keep note.
  if (typeof createdTimestampUsec !== 'number' || typeof userEditedTimestampUsec !== 'number') {
    return null
  }

  return {
    title: typeof raw['title'] === 'string' ? raw['title'] : '',
    textContent: typeof raw['textContent'] === 'string' ? raw['textContent'] : '',
    listContent: parseListContent(raw['listContent']),
    color: typeof raw['color'] === 'string' ? raw['color'] : 'DEFAULT',
    labels: parseLabels(raw['labels']),
    isPinned: raw['isPinned'] === true,
    isArchived: raw['isArchived'] === true,
    isTrashed: raw['isTrashed'] === true,
    attachments: parseAttachments(raw['attachments']),
    createdTimestampUsec,
    userEditedTimestampUsec
  }
}
