import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import type { MobilePullStore } from '../db/pull-store'
import type { VaultDb } from '../db/index'

const log = createLogger('NoteMaterializer')

const CRDT_FRAGMENT_NAME = 'prosemirror'

/**
 * Materialize a pulled note's CRDT state into preview markdown (T050 scope).
 *
 * This is a deliberately BEST-EFFORT serializer: the real Y.Doc → markdown
 * converter lives behind `@blocknote/server-util` (jsdom; desktop main only)
 * and cannot run on Hermes. The Phase 4 WebView editor renders the true doc;
 * until then the preview walks the BlockNote XML tree and emits plain
 * markdown-ish text — headings, lists, quotes, code fences, task markers and
 * inline bold/italic/code survive; exotic blocks degrade to their text.
 *
 * The record payload's create-time `content` stays in `note_bodies` until the
 * first CRDT state arrives; after that the CRDT is the body's truth (same
 * ownership rule as desktop).
 */
export async function materializeNoteBody(
  db: VaultDb,
  store: MobilePullStore,
  noteId: string
): Promise<boolean> {
  const { snapshot, updates } = await store.loadCrdtDoc(noteId)
  if (!snapshot && updates.length === 0) return false

  const doc = new Y.Doc()
  try {
    if (snapshot) Y.applyUpdate(doc, snapshot)
    for (const update of updates) Y.applyUpdate(doc, update)
  } catch (err) {
    log.warn('CRDT state failed to apply; keeping previous body', {
      noteId,
      error: err instanceof Error ? err.message : String(err)
    })
    doc.destroy()
    return false
  }

  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const markdown = fragmentToMarkdown(fragment)
  doc.destroy()

  await db.runAsync(
    `INSERT INTO note_bodies (item_id, markdown, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET markdown = excluded.markdown, fetched_at = excluded.fetched_at`,
    [noteId, markdown, Date.now()]
  )
  return true
}

function fragmentToMarkdown(fragment: Y.XmlFragment): string {
  const lines: string[] = []
  serializeChildren(fragment, lines, 0)
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  )
}

function serializeChildren(
  node: Y.XmlFragment | Y.XmlElement,
  lines: string[],
  depth: number
): void {
  for (let i = 0; i < node.length; i++) {
    const child = node.get(i)
    if (child instanceof Y.XmlElement) serializeElement(child, lines, depth)
  }
}

function serializeElement(el: Y.XmlElement, lines: string[], depth: number): void {
  const name = el.nodeName
  if (name === 'blockGroup') {
    serializeChildren(el, lines, depth)
    return
  }
  if (name === 'blockContainer') {
    for (let i = 0; i < el.length; i++) {
      const child = el.get(i)
      if (!(child instanceof Y.XmlElement)) continue
      if (child.nodeName === 'blockGroup') {
        serializeChildren(child, lines, depth + 1)
      } else {
        serializeElement(child, lines, depth)
      }
    }
    return
  }

  const indent = '  '.repeat(depth)
  const text = inlineText(el)

  switch (name) {
    case 'heading': {
      const level = Number(el.getAttribute('level') ?? 1)
      lines.push('', `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${text}`, '')
      break
    }
    case 'bulletListItem':
      lines.push(`${indent}- ${text}`)
      break
    case 'numberedListItem':
      lines.push(`${indent}1. ${text}`)
      break
    case 'checkListItem':
    case 'taskItem': {
      const checked = el.getAttribute('checked') === 'true'
      lines.push(`${indent}- [${checked ? 'x' : ' '}] ${text}`)
      break
    }
    case 'codeBlock': {
      const language = el.getAttribute('language') ?? ''
      lines.push('', `\`\`\`${language}`, rawText(el), '```', '')
      break
    }
    case 'quote':
    case 'blockquote':
      lines.push(`${indent}> ${text}`)
      break
    case 'table': {
      lines.push('')
      serializeTable(el, lines)
      lines.push('')
      break
    }
    default:
      if (text.length > 0) lines.push(`${indent}${text}`)
      else if (el.length > 0) serializeChildren(el, lines, depth)
      else lines.push('')
  }
}

function serializeTable(table: Y.XmlElement, lines: string[]): void {
  let firstRow = true
  for (let i = 0; i < table.length; i++) {
    const row = table.get(i)
    if (!(row instanceof Y.XmlElement)) continue
    const cells: string[] = []
    for (let j = 0; j < row.length; j++) {
      const cell = row.get(j)
      if (cell instanceof Y.XmlElement) {
        // Escape backslashes BEFORE pipes so cell text can never reconstruct
        // an unescaped `|`, and flatten newlines that would break the row.
        cells.push(
          inlineText(cell).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, ' ')
        )
      }
    }
    if (cells.length === 0) continue
    lines.push(`| ${cells.join(' | ')} |`)
    if (firstRow) {
      lines.push(`| ${cells.map(() => '---').join(' | ')} |`)
      firstRow = false
    }
  }
}

function inlineText(el: Y.XmlElement): string {
  let out = ''
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i)
    if (child instanceof Y.XmlText) {
      out += deltaToMarkdown(child)
    } else if (child instanceof Y.XmlElement) {
      out += inlineText(child)
    }
  }
  return out
}

function rawText(el: Y.XmlElement): string {
  let out = ''
  for (let i = 0; i < el.length; i++) {
    const child = el.get(i)
    if (child instanceof Y.XmlText) out += child.toString()
    else if (child instanceof Y.XmlElement) out += rawText(child)
  }
  return out
}

interface TextDelta {
  insert?: unknown
  attributes?: Record<string, unknown>
}

function deltaToMarkdown(textNode: Y.XmlText): string {
  let out = ''
  for (const delta of textNode.toDelta() as TextDelta[]) {
    if (typeof delta.insert !== 'string') continue
    let piece = delta.insert
    const attrs = delta.attributes ?? {}
    if (attrs.code) piece = `\`${piece}\``
    if (attrs.bold) piece = `**${piece}**`
    if (attrs.italic) piece = `*${piece}*`
    if (attrs.strike || attrs.strikethrough) piece = `~~${piece}~~`
    out += piece
  }
  return out
}
