/**
 * Generic jsdom-based HTML → Markdown converter shared across importers.
 *
 * Extracted from the Notion importer's hand-rolled converter so HTML, Evernote,
 * Apple Journal and OneNote can reuse one DOM walker. Source-specific behaviour
 * (wikilink resolution, attachment lookup, blocks to drop) is supplied through
 * {@link HtmlToMarkdownHooks}; with no hooks the converter emits portable
 * CommonMark and collects every local asset ref for the caller to resolve.
 *
 * @module main/import/_shared/html-to-markdown
 */

const TEXT_NODE = 3
const ELEMENT_NODE = 1

export interface HtmlToMarkdownHooks {
  /**
   * Resolve an `<a>` to markdown. `collect` registers an asset ref the caller
   * should copy + rewrite. Return a string to use it, or `null`/`undefined` to
   * fall back to the default (external link kept, local ref collected + linked).
   */
  anchor?(href: string, text: string, collect: (asset: string) => void): string | null | undefined
  /** Resolve an `<img>` (same contract as {@link HtmlToMarkdownHooks.anchor}). */
  image?(src: string, alt: string, collect: (asset: string) => void): string | null | undefined
  /** Return true to drop a block element entirely (e.g. a metadata table). */
  skipBlock?(el: Element): boolean
}

export interface HtmlToMarkdownResult {
  markdown: string
  /** Local/relative refs encountered, in document order (deduped by the caller). */
  assets: string[]
}

interface Ctx {
  hooks: HtmlToMarkdownHooks
  assets: string[]
  collect: (asset: string) => void
}

/**
 * Convert an element's children into markdown. Pass the page-body root, not the
 * document; the root's own tag is not rendered, only its block children.
 */
export function htmlToMarkdown(
  root: Element,
  hooks: HtmlToMarkdownHooks = {}
): HtmlToMarkdownResult {
  const assets: string[] = []
  const ctx: Ctx = { hooks, assets, collect: (a) => assets.push(a) }
  const markdown = renderBlocks(ctx, root).trim()
  return { markdown, assets }
}

/** Percent-decode a ref, preserving `../` segments (tolerant of malformed `%`). */
export function percentDecodeRef(ref: string): string {
  try {
    return decodeURIComponent(ref)
  } catch {
    return ref
  }
}

/** Strip leading `../` segments and percent-decode a local ref (Notion layout). */
export function decodeRef(ref: string): string {
  return percentDecodeRef(ref.replace(/^(\.\.\/)+/, ''))
}

// ============================================================================
// Block level
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
  if (ctx.hooks.skipBlock?.(el)) return ''
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
      return renderTable(ctx, el)
    case 'img':
      return renderImage(ctx, el)
    case 'header':
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
// Inline level
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
  const fromHook = ctx.hooks.anchor?.(href, text, ctx.collect)
  if (fromHook != null) return fromHook
  return defaultAnchor(ctx, href, text)
}

function defaultAnchor(ctx: Ctx, href: string, text: string): string {
  if (!href) return text
  if (/^(https?:\/\/|mailto:)/i.test(href)) return `[${text}](${href})`
  const decoded = decodeRef(href)
  ctx.collect(decoded)
  return `[${text || decoded}](${decoded})`
}

function renderImage(ctx: Ctx, img: Element): string {
  const src = img.getAttribute('src') ?? ''
  const alt = (img.getAttribute('alt') ?? '').trim()
  const fromHook = ctx.hooks.image?.(src, alt, ctx.collect)
  if (fromHook != null) return fromHook
  return defaultImage(ctx, src, alt)
}

function defaultImage(ctx: Ctx, src: string, alt: string): string {
  if (!src) return ''
  if (/^(https?:\/\/|data:)/i.test(src)) return `![${alt}](${src})`
  const decoded = decodeRef(src)
  ctx.collect(decoded)
  return `![${alt}](${decoded})`
}
