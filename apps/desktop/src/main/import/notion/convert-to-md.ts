import { getNotionId } from './notion-utils'
import { htmlToMarkdown, decodeRef } from '../_shared/html-to-markdown'
import type { NotionResolverInfo } from './resolver'

export interface ConvertResult {
  body: string
  properties: Record<string, unknown>
  tags: string[]
  /** Decoded attachment refs used in the body, for the orchestrator to copy + rewrite. */
  assets: string[]
}

/**
 * Convert a Notion HTML page (jsdom `Document`) into Memry markdown.
 *
 * Returns the body separately from frontmatter `properties`/`tags` so the
 * orchestrator can pass them to `createNote`. The generic DOM walk lives in the
 * shared {@link htmlToMarkdown}; Notion-specific behaviour (page-link wikilinks,
 * attachment resolution, the properties table) is supplied through its hooks.
 */
export function convertHtmlToMarkdown(
  info: NotionResolverInfo,
  doc: Document,
  _filepath: string
): ConvertResult {
  const { properties, tags } = extractProperties(doc)

  const root =
    doc.querySelector('div.page-body') ?? doc.querySelector('article') ?? doc.body ?? undefined
  if (!root) return { body: '', properties, tags, assets: [] }

  const { markdown, assets } = htmlToMarkdown(root, {
    skipBlock: (el) => {
      const tag = el.tagName.toLowerCase()
      return tag === 'header' || (tag === 'table' && el.classList.contains('properties'))
    },
    anchor: (href, text, collect) => {
      if (!href) return text
      const decoded = decodeRef(href)
      const id = getNotionId(decoded)
      if (id && decoded.endsWith('.html') && info.idsToFileInfo[id]) {
        return `[[${info.idsToFileInfo[id].title}]]`
      }
      const attachment = findAttachmentRef(info, decoded)
      if (attachment) {
        collect(attachment)
        return `[${text || decoded}](${attachment})`
      }
      if (/^(https?:\/\/|mailto:)/i.test(href)) return `[${text}](${href})`
      return text
    },
    image: (src, alt, collect) => {
      if (!src) return ''
      const decoded = decodeRef(src)
      const attachment = findAttachmentRef(info, decoded)
      if (attachment) {
        collect(attachment)
        return `![${alt}](${attachment})`
      }
      return `![${alt}](${src})`
    }
  })

  return { body: markdown, properties, tags, assets }
}

// ============================================================================
// Properties → frontmatter (Notion-specific)
// ============================================================================

function extractProperties(doc: Document): {
  properties: Record<string, unknown>
  tags: string[]
} {
  const properties: Record<string, unknown> = {}
  const tags: string[] = []

  const table = doc.querySelector('table.properties')
  if (!table) return { properties, tags }

  for (const row of Array.from(table.querySelectorAll('tr'))) {
    const cls = row.className
    if (/property-row-(created_time|last_edited_time)/.test(cls)) continue

    const cells = Array.from(row.querySelectorAll('th, td'))
    if (cells.length < 2) continue

    const name = (cells[0].textContent ?? '').trim()
    if (!name) continue
    const valueCell = cells[cells.length - 1]
    const type = detectPropertyType(row, valueCell)

    if (type === 'multi_select' || type === 'relation' || type === 'file') {
      const values = collectChips(valueCell)
      if (name.toLowerCase() === 'tags') tags.push(...values)
      else if (values.length > 0) properties[name] = values
    } else if (name.toLowerCase() === 'tags') {
      tags.push(...collectChips(valueCell))
    } else {
      const text = (valueCell.textContent ?? '').trim()
      if (text) properties[name] = text
    }
  }

  return { properties, tags }
}

function detectPropertyType(row: Element, cell: Element): string {
  const fromRow = row.className.match(/property-row-([a-z_]+)/)
  if (fromRow && fromRow[1] !== 'property') return fromRow[1]
  const cellClass = cell.className || ''
  if (/multi_select/.test(cellClass)) return 'multi_select'
  if (/relation/.test(cellClass)) return 'relation'
  if (/\bfile\b/.test(cellClass)) return 'file'
  return 'text'
}

function collectChips(cell: Element): string[] {
  let nodes = Array.from(cell.querySelectorAll(':scope > span'))
  if (nodes.length === 0) nodes = Array.from(cell.children)
  const values = nodes.map((n) => (n.textContent ?? '').trim()).filter(Boolean)
  if (values.length > 0) return values
  const text = (cell.textContent ?? '').trim()
  return text ? [text] : []
}

/** Find the attachment key whose path matches a decoded body ref. */
function findAttachmentRef(info: NotionResolverInfo, decoded: string): string | undefined {
  const keys = Object.keys(info.pathsToAttachmentInfo)
  return keys.find((key) => key === decoded || key.endsWith(decoded) || key.includes(decoded))
}
