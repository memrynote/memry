import { getNotionId } from './notion-utils'
import type { NotionResolverInfo } from './resolver'

export interface ConvertResult {
  body: string
  properties: Record<string, unknown>
  tags: string[]
  /** Decoded attachment refs used in the body, for the orchestrator to copy + rewrite. */
  assets: string[]
}

const TEXT_NODE = 3
const ELEMENT_NODE = 1

/**
 * Convert a Notion HTML page (jsdom `Document`) into Memry markdown.
 *
 * Returns the body separately from frontmatter `properties`/`tags` so the
 * orchestrator can pass them to `createNote`. Internal page links become
 * `[[Title]]` wikilinks; attachment refs are emitted verbatim and collected in
 * `assets` for the orchestrator to copy and rewrite.
 */
export function convertHtmlToMarkdown(
  info: NotionResolverInfo,
  doc: Document,
  _filepath: string
): ConvertResult {
  const { properties, tags } = extractProperties(doc)

  const root =
    doc.querySelector('div.page-body') ?? doc.querySelector('article') ?? doc.body ?? undefined

  const assets: string[] = []
  const ctx: Ctx = { info, assets }
  const body = root ? renderBlocks(ctx, root).trim() : ''

  return { body, properties, tags, assets }
}

interface Ctx {
  info: NotionResolverInfo
  assets: string[]
}

// ============================================================================
// Properties → frontmatter
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

// ============================================================================
// Body blocks
// ============================================================================

function renderBlocks(ctx: Ctx, parent: Element): string {
  const parts: string[] = []
  for (const child of Array.from(parent.children)) {
    const md = renderBlock(ctx, child)
    if (md && md.trim()) parts.push(md.trim())
  }
  return parts.join('\n\n')
}

function renderBlock(ctx: Ctx, el: Element): string {
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'h1':
      return '# ' + renderInline(ctx, el)
    case 'h2':
      return '## ' + renderInline(ctx, el)
    case 'h3':
      return '### ' + renderInline(ctx, el)
    case 'h4':
      return '#### ' + renderInline(ctx, el)
    case 'h5':
    case 'h6':
      return '##### ' + renderInline(ctx, el)
    case 'p':
      return renderInline(ctx, el).trim()
    case 'ul':
    case 'ol':
      return renderList(ctx, el, tag === 'ol')
    case 'blockquote':
      return renderBlockquote(ctx, el)
    case 'pre':
      return renderCode(el)
    case 'hr':
      return '---'
    case 'figure':
      return renderFigure(ctx, el)
    case 'table':
      if (el.classList.contains('properties')) return ''
      return renderTable(ctx, el)
    case 'header':
      return ''
    case 'img':
      return renderImage(ctx, el)
    case 'div':
    case 'article':
    case 'section':
    case 'main':
      return renderBlocks(ctx, el)
    default:
      return renderInline(ctx, el).trim()
  }
}

function renderList(ctx: Ctx, listEl: Element, ordered: boolean): string {
  const items = Array.from(listEl.children).filter((c) => c.tagName.toLowerCase() === 'li')
  const lines = items.map((li, i) => {
    const todo = parseTodo(ctx, li)
    if (todo) return `${todo.checked ? '- [x]' : '- [ ]'} ${todo.text}`
    const marker = ordered ? `${i + 1}.` : '-'
    return `${marker} ${renderInline(ctx, li).trim()}`
  })
  return lines.join('\n')
}

function parseTodo(ctx: Ctx, li: Element): { checked: boolean; text: string } | null {
  const input = li.querySelector('input[type="checkbox"]')
  const box = li.querySelector('.checkbox')
  const isTodo =
    !!input ||
    !!box ||
    li.classList.contains('to-do') ||
    Boolean(li.parentElement?.classList.contains('to-do-list'))
  if (!isTodo) return null

  const checked = input
    ? input.hasAttribute('checked')
    : box
      ? box.classList.contains('checkbox-on')
      : false
  return { checked, text: renderInline(ctx, li).trim() }
}

function renderBlockquote(ctx: Ctx, el: Element): string {
  const inner = renderBlocks(ctx, el) || renderInline(ctx, el)
  return inner
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function renderCode(pre: Element): string {
  const codeEl = pre.querySelector('code') ?? pre
  const text = (codeEl.textContent ?? '').replace(/\n$/, '')
  const langClass = (codeEl.className || pre.className).match(/language-([\w-]+)/)
  const lang = langClass ? langClass[1].toLowerCase() : ''
  return '```' + lang + '\n' + text + '\n```'
}

function renderFigure(ctx: Ctx, fig: Element): string {
  if (fig.classList.contains('callout')) {
    const content = fig.lastElementChild ?? fig
    const inner = renderBlocks(ctx, content) || renderInline(ctx, content)
    return inner
      .split('\n')
      .map((line) => (line ? `> ${line}` : '>'))
      .join('\n')
  }
  const img = fig.querySelector('img')
  if (img) return renderImage(ctx, img)
  return renderBlocks(ctx, fig)
}

function renderTable(ctx: Ctx, table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr'))
  if (rows.length === 0) return ''
  const matrix = rows.map((row) =>
    Array.from(row.querySelectorAll('th, td')).map((cell) =>
      renderInline(ctx, cell).replace(/\n/g, ' ').trim()
    )
  )
  const cols = Math.max(...matrix.map((r) => r.length))
  const pad = (r: string[]): string[] => [...r, ...Array(cols - r.length).fill('')]
  const header = pad(matrix[0])
  const divider = Array(cols).fill('---')
  const bodyRows = matrix.slice(1).map(pad)
  const toLine = (r: string[]): string => `| ${r.join(' | ')} |`
  return [toLine(header), toLine(divider), ...bodyRows.map(toLine)].join('\n')
}

// ============================================================================
// Inline
// ============================================================================

function renderInline(ctx: Ctx, el: Element): string {
  let out = ''
  for (const node of Array.from(el.childNodes)) {
    out += renderInlineNode(ctx, node)
  }
  return out
}

function renderInlineNode(ctx: Ctx, node: ChildNode): string {
  if (node.nodeType === TEXT_NODE) return node.textContent ?? ''
  if (node.nodeType !== ELEMENT_NODE) return ''

  const el = node as Element
  const tag = el.tagName.toLowerCase()
  switch (tag) {
    case 'br':
      return '\n'
    case 'strong':
    case 'b':
      return `**${renderInline(ctx, el)}**`
    case 'em':
    case 'i':
      return `*${renderInline(ctx, el)}*`
    case 'del':
    case 's':
    case 'strike':
      return `~~${renderInline(ctx, el)}~~`
    case 'mark':
      return `==${renderInline(ctx, el)}==`
    case 'code':
      return '`' + (el.textContent ?? '') + '`'
    case 'a':
      return renderAnchor(ctx, el)
    case 'img':
      return renderImage(ctx, el)
    case 'input':
      return ''
    case 'time':
      return (el.textContent ?? '').replace(/@/g, '')
    default:
      if (el.classList.contains('checkbox')) return ''
      return renderInline(ctx, el)
  }
}

function renderAnchor(ctx: Ctx, a: Element): string {
  const href = a.getAttribute('href') ?? ''
  const text = renderInline(ctx, a).trim() || (a.textContent ?? '').trim()
  if (!href) return text

  const decoded = decodeRef(href)
  const id = getNotionId(decoded)
  if (id && decoded.endsWith('.html') && ctx.info.idsToFileInfo[id]) {
    return `[[${ctx.info.idsToFileInfo[id].title}]]`
  }

  const attachment = findAttachmentRef(ctx, decoded)
  if (attachment) {
    ctx.assets.push(attachment)
    return `[${text || decoded}](${attachment})`
  }

  if (/^(https?:\/\/|mailto:)/i.test(href)) return `[${text}](${href})`
  return text
}

function renderImage(ctx: Ctx, img: Element): string {
  const src = img.getAttribute('src') ?? ''
  const alt = (img.getAttribute('alt') ?? '').trim()
  if (!src) return ''
  const decoded = decodeRef(src)
  const attachment = findAttachmentRef(ctx, decoded)
  if (attachment) {
    ctx.assets.push(attachment)
    return `![${alt}](${attachment})`
  }
  return `![${alt}](${src})`
}

function decodeRef(ref: string): string {
  const withoutParents = ref.replace(/^(\.\.\/)+/, '')
  try {
    return decodeURIComponent(withoutParents)
  } catch {
    return withoutParents
  }
}

/** Find the attachment key whose path matches a decoded body ref. */
function findAttachmentRef(ctx: Ctx, decoded: string): string | undefined {
  const keys = Object.keys(ctx.info.pathsToAttachmentInfo)
  return keys.find((key) => key === decoded || key.endsWith(decoded) || key.includes(decoded))
}
