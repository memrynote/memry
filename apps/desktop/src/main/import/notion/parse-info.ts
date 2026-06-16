import { getNotionId, parseParentIds } from './notion-utils'

export interface ParsedPageInfo {
  id: string
  title: string
  parentIds: string[]
  ctime: Date | null
  mtime: Date | null
}

/**
 * Pure (FS-free) parse of a Notion HTML page: its id (from the first body child
 * carrying a Notion id), full title (from `<title>`), and created/last-edited
 * timestamps (from the property table). Parses via `jsdom`.
 */
export function parsePageInfo(doc: Document, filepath: string): ParsedPageInfo {
  const children = doc.body?.children
  let id: string | undefined
  if (children) {
    for (let i = 0; i < children.length; i++) {
      id = getNotionId(children[i].getAttribute('id') ?? '')
      if (id) break
    }
  }
  if (!id) {
    throw new Error(`No Notion id found for: ${filepath}`)
  }

  const ctime = extractTime(doc, 'property-row-created_time')
  const mtime = extractTime(doc, 'property-row-last_edited_time')

  // Notion truncates filenames, so read the full title from <title>.
  const parsedTitle = doc.querySelector('title')?.textContent || 'Untitled'
  const title = stripTo200(sanitizeTitle(parsedTitle))

  return { id, title, parentIds: parseParentIds(filepath), ctime, mtime }
}

function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\n/g, ' ')
    .replace(/[:/]/g, '-')
    .replace(/#/g, '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
}

function extractTime(doc: Document, trClassName: string): Date | null {
  const tr = doc.querySelector(`tr.${trClassName}`)
  const text = tr?.querySelector('time')?.textContent
  if (!text) return null
  return parseDateTime(text)
}

function parseDateTime(dateTimeStr: string): Date | null {
  const cleaned = dateTimeStr.startsWith('@') ? dateTimeStr.slice(1).trim() : dateTimeStr.trim()
  const date = new Date(cleaned)
  return isNaN(date.getTime()) ? null : date
}

function stripTo200(title: string): string {
  if (title.length < 200) return title

  const words = title.split(' ')
  const kept: string[] = []
  let length = 0
  let i = 0
  let complete = false
  while (length < 200) {
    if (!words[i]) {
      complete = true
      break
    }
    kept.push(words[i])
    length += words[i].length + 1
    i++
  }
  return complete ? kept.join(' ') : kept.join(' ') + '...'
}
