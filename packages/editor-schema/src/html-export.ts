import { createFenceTracker } from '@memry/shared/markdown-fences'
import {
  DETAILS_OPEN_LINE_REGEX,
  TOGGLE_CLOSE_LINE,
  TOGGLE_OPEN_LINE_REGEX,
  TOGGLE_SUMMARY_LINE_REGEX
} from './blocks/markdown.ts'
import {
  HANDLED_TAGS,
  maskRawHtmlSpans,
  readHtmlTag,
  restoreRawHtml,
  scanRawHtml,
  type Tag
} from './inline/raw-html.ts'

/**
 * Note markdown to HTML a reader can open without running anything.
 *
 * The editor shows raw HTML it has no node for (`<script>`, `<svg onload>`,
 * `<iframe>`, `<kbd>`) as the text the author wrote (`scanRawHtml`, chapter 12),
 * and the vault file keeps those characters. An HTML export has to say the same:
 * a markdown-to-HTML pass hands a tag through, so `Pasted: <script>…</script>`
 * would become a live script in a file the user opens or sends on.
 *
 * Two steps around the caller's markdown parser, which keeps its own options:
 *
 * 1. `maskRawHtmlForExport` hides every construct the editor reads as text,
 *    through the same scan the editor uses, so the parser never sees a tag
 *    there. The toggle lines (`<details data-memry-toggle>`, its `<summary>`
 *    and `</details>`) are the one thing the editor reads before that scan, so
 *    they stay markup here too.
 * 2. `finish` rebuilds each tag the parser left (the handled ones Memry writes,
 *    and the parser's own) from an attribute allowlist, drops an address that
 *    runs script, and puts the hidden constructs back as escaped text.
 */

export interface ExportHtmlMask {
  /** The markdown to hand to the parser. */
  markdown: string
  /** The parser's HTML with the hidden constructs back as text and every tag made inert. */
  finish: (html: string) => string
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
}
const escapeText = (text: string): string => text.replace(/[&<>"']/g, (char) => ESCAPES[char])

/** The start of each span that is toggle markup, which the editor reads before the scan. */
function toggleMarkupStarts(markdown: string): Set<number> {
  const starts = new Set<number>()
  // For each `<details>` still open, whether it is a toggle.
  const open: boolean[] = []
  const fence = createFenceTracker()
  let base = 0
  for (const line of markdown.split('\n')) {
    if (!fence.consume(line)) {
      if (TOGGLE_OPEN_LINE_REGEX.test(line)) open.push(true)
      else if (DETAILS_OPEN_LINE_REGEX.test(line)) open.push(false)
      else if (line === TOGGLE_CLOSE_LINE) {
        if (open.pop() === true) starts.add(base)
      } else if (open.at(-1) === true && TOGGLE_SUMMARY_LINE_REGEX.test(line)) {
        starts.add(base)
        starts.add(base + line.length - '</summary>'.length)
      }
    }
    base += line.length + 1
  }
  return starts
}

/** `markdown` with every construct the editor shows as text hidden from the parser. */
export function maskRawHtmlForExport(markdown: string): ExportHtmlMask {
  const spans = scanRawHtml(markdown, true)
  const toggles = spans.length > 0 ? toggleMarkupStarts(markdown) : new Set<number>()
  const { markdown: masked, sources } = maskRawHtmlSpans(
    markdown,
    spans.filter((span) => !toggles.has(span.start))
  )
  const escaped = sources.map(escapeText)
  return { markdown: masked, finish: (html) => restoreRawHtml(sanitizeExportHtml(html), escaped) }
}

/** Tags the parser writes itself, beside the handled ones. */
const PARSER_TAGS: ReadonlySet<string> = new Set([
  'p',
  'span',
  'sup',
  'section',
  'details',
  'summary',
  'input'
])

const GLOBAL_ATTRS: ReadonlySet<string> = new Set(['class', 'id', 'title', 'lang', 'dir', 'style'])
const TAG_ATTRS: Readonly<Record<string, readonly string[]>> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  source: ['src', 'type'],
  video: ['src', 'poster', 'controls', 'loop', 'muted', 'preload', 'width', 'height'],
  audio: ['src', 'controls', 'loop', 'muted', 'preload'],
  td: ['colspan', 'rowspan', 'align'],
  th: ['colspan', 'rowspan', 'align', 'scope'],
  ol: ['start', 'type', 'reversed'],
  li: ['value'],
  details: ['open'],
  input: ['type', 'checked', 'disabled'],
  col: ['span', 'width'],
  colgroup: ['span']
}
const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'poster'])
/** Written without a value, as the toggle line and the browser's own forms are. */
const BARE_ATTRS: ReadonlySet<string> = new Set([
  'open',
  'data-memry-toggle',
  'controls',
  'loop',
  'muted'
])

const SCRIPT_SCHEMES: ReadonlySet<string> = new Set([
  'javascript',
  'vbscript',
  'livescript',
  'data',
  'blob',
  'filesystem'
])
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|svg\+xml)[;,]/

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  colon: ':',
  tab: '\t',
  newline: '\n',
  nbsp: '\u00a0'
}

/** What a browser reads in an attribute value, for the parts a scheme can hide in. */
function decodeEntities(value: string): string {
  return value.replace(
    /&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|([a-zA-Z]+));?/g,
    (whole, hex, dec, name) => {
      if (name !== undefined) return NAMED_ENTITIES[name.toLowerCase()] ?? whole
      const code = hex !== undefined ? parseInt(hex, 16) : parseInt(dec, 10)
      return code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
  )
}

/** What a browser drops from a URL before it reads the scheme: control characters and spaces. */
// oxlint-disable-next-line no-control-regex -- the characters a URL parser skips
const URL_SKIPPED = /[\u0000-\u0020\u007f]/g

/** Whether `value` is an address this tag may carry. A relative address and a plain scheme are. */
function isSafeAddress(tag: string, value: string): boolean {
  const address = decodeEntities(value).replace(URL_SKIPPED, '').toLowerCase()
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(address)?.[1]
  if (scheme === undefined || !SCRIPT_SCHEMES.has(scheme)) return true
  return tag === 'img' && SAFE_DATA_IMAGE.test(address)
}

const STYLE_PROPERTIES: ReadonlySet<string> = new Set([
  'color',
  'background-color',
  'text-decoration',
  'text-decoration-line',
  'text-align',
  'font-weight',
  'font-style'
])
const STYLE_VALUE = /^[#\w\s(),.%+-]+$/
const STYLE_FUNCTION = /([\w-]+)\s*\(/g
const STYLE_FUNCTIONS: ReadonlySet<string> = new Set(['rgb', 'rgba', 'hsl', 'hsla'])

/** The declarations of `style` that set a colour or a text decoration, or null when none do. */
function safeStyle(style: string): string | null {
  const kept: string[] = []
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const value = declaration.slice(colon + 1).trim()
    if (!STYLE_PROPERTIES.has(property) || !STYLE_VALUE.test(value)) continue
    const functions = [...value.matchAll(STYLE_FUNCTION)].map((match) => match[1].toLowerCase())
    if (functions.every((name) => STYLE_FUNCTIONS.has(name))) kept.push(`${property}:${value}`)
  }
  return kept.length > 0 ? kept.join(';') : null
}

function isAllowedAttribute(tag: string, name: string): boolean {
  return (
    GLOBAL_ATTRS.has(name) ||
    name.startsWith('data-') ||
    name.startsWith('aria-') ||
    (name === 'align' && (tag === 'td' || tag === 'th')) ||
    (TAG_ATTRS[tag]?.includes(name) ?? false)
  )
}

function renderAttribute(tag: string, name: string, value: string): string | null {
  if (!isAllowedAttribute(tag, name)) return null
  let kept = value
  if (URL_ATTRS.has(name) && !isSafeAddress(tag, value)) return null
  if (name === 'style') {
    const style = safeStyle(decodeEntities(value))
    if (style === null) return null
    kept = style
  }
  if (kept === '' && BARE_ATTRS.has(name)) return ` ${name}`
  return ` ${name}="${kept.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`
}

/** `tag` as inert markup, or null when it is not a tag this export carries. */
function renderTag({ name, closing, selfClosing, attrs }: Tag): string | null {
  if (!HANDLED_TAGS.has(name) && !PARSER_TAGS.has(name)) return null
  if (closing) return `</${name}>`
  if (name === 'input' && !attrs.some(([attr, value]) => attr === 'type' && value === 'checkbox')) {
    return null
  }
  const attributes = attrs.map(([attr, value]) => renderAttribute(name, attr, value) ?? '').join('')
  return `<${name}${attributes}${selfClosing ? ' /' : ''}>`
}

/** A closed comment that no browser reads differently from this scan, or null. */
function readComment(html: string, at: number): number | null {
  if (!html.startsWith('<!--', at)) return null
  const close = html.indexOf('-->', at + 4)
  if (close < 0) return null
  const body = html.slice(at + 4, close)
  return body.startsWith('>') || body.startsWith('->') || body.includes('--!>') ? null : close + 3
}

/**
 * `html` with every tag that is not one this export carries as escaped text,
 * and every tag it carries rebuilt from an attribute allowlist with no
 * `on…` handler, no `srcdoc`, no script address and no style but a colour.
 */
export function sanitizeExportHtml(html: string): string {
  let out = ''
  let last = 0
  for (let at = html.indexOf('<'); at >= 0; at = html.indexOf('<', last)) {
    out += html.slice(last, at)
    const commentEnd = readComment(html, at)
    const read = commentEnd === null ? readHtmlTag(html, at) : null
    const rendered = read === null ? null : renderTag(read.tag)
    if (commentEnd !== null) {
      out += html.slice(at, commentEnd)
      last = commentEnd
    } else if (read === null) {
      out += '&lt;'
      last = at + 1
    } else {
      out += rendered ?? escapeText(html.slice(at, read.end))
      last = read.end
    }
  }
  return out + html.slice(last)
}
