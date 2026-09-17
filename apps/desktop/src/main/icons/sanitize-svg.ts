/**
 * Conservative SVG sanitizer for stored custom icons.
 *
 * Custom icons are the one format we keep verbatim, and an SVG is a document:
 * it can carry script, event handlers, external references and entity
 * declarations. We only ever render icons through `<img src>`, which does not
 * execute script, so this is defense in depth — the point is that the bytes
 * sitting in `.memry/icons` (and syncing to every device) are inert whatever a
 * future renderer, export path or external tool does with them.
 *
 * It is deliberately a stripper, not a detector: anything not on the allowlist
 * is removed rather than rejected, so a legitimate icon carrying a stray
 * `<a>` wrapper still renders. `<a>` elements are unwrapped (tags dropped,
 * children kept) because the drawing inside them is the icon.
 *
 * Returns `null` when nothing usable survives, which callers treat as an
 * unreadable image.
 *
 * @module icons/sanitize-svg
 */

/** Elements dropped together with everything inside them. */
const FORBIDDEN_ELEMENTS = ['script', 'foreignObject', 'iframe', 'embed', 'object', 'handler']
const FORBIDDEN_LOCAL_NAMES = new Set(FORBIDDEN_ELEMENTS.map((tag) => tag.toLowerCase()))

/** Elements whose tags are dropped while their children are kept. */
const UNWRAPPED_ELEMENTS = new Set(['a'])

/** SMIL elements that can rewrite another element's attribute after load. */
const ANIMATION_ELEMENTS = new Set(['animate', 'set', 'animatetransform', 'animatemotion'])

/** Animation attributes carrying the value that gets written. */
const ANIMATION_VALUE_ATTRIBUTES = new Set(['to', 'from', 'values', 'by'])

/** Attributes that may carry a URL. */
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'xml:href', 'src', 'xlink:src'])

/**
 * Optional XML namespace prefix.
 *
 * `<svg:script>` is the same element as `<script>` to any XML parser, so every
 * element rule matches on the local name — a prefix must never be a way past
 * the allowlist.
 */
const TAG_PREFIX = '(?:[A-Za-z_][\\w.-]*:)*'

/**
 * Local name of a tag, after every `prefix:` segment.
 *
 * `<a:b:script>` is not a legal QName, but nothing guarantees the next parser
 * agrees, so the last segment is what every rule compares against.
 */
function localName(name: string): string {
  return name.replace(/^.*:/, '').toLowerCase()
}

const COMMENT_RE = /<!--[\s\S]*?-->/g
/** DOCTYPE, including any internal subset — the billion-laughs / XXE vector. */
const DOCTYPE_RE = /<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>/gi
const ENTITY_RE = /<!ENTITY[\s\S]*?>/gi
/** Processing instructions, including `<?xml-stylesheet ?>`. */
const PI_RE = /<\?[\s\S]*?\?>/g
const CDATA_RE = /<!\[CDATA\[[\s\S]*?\]\]>/g

const TAG_RE = /<\/?([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g
const ATTR_RE = /([^\s"'=/<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

/** Drop `<style>` blocks that reach outside the document (`@import`, `url()`). */
function stripUnsafeStyleElements(svg: string): string {
  return svg.replace(
    new RegExp(`<${TAG_PREFIX}style\\b[^>]*>([\\s\\S]*?)<\\/${TAG_PREFIX}style\\s*>`, 'gi'),
    (whole, css: string) => (isSafeStyleValue(css) ? whole : '')
  )
}

function stripForbiddenElements(svg: string): string {
  let out = svg
  for (const tag of FORBIDDEN_ELEMENTS) {
    // Self-closing form, then the paired form (content goes with it), then an
    // unclosed open tag — which takes the rest of the document, because there
    // is no way to tell where its content was meant to end.
    out = out.replace(new RegExp(`<${TAG_PREFIX}${tag}\\b[^>]*\\/>`, 'gi'), '')
    out = out.replace(
      new RegExp(`<${TAG_PREFIX}${tag}\\b[\\s\\S]*?<\\/${TAG_PREFIX}${tag}\\s*>`, 'gi'),
      ''
    )
    out = out.replace(new RegExp(`<${TAG_PREFIX}${tag}\\b[\\s\\S]*$`, 'i'), '')
    out = out.replace(new RegExp(`<\\/${TAG_PREFIX}${tag}\\b[^>]*>`, 'gi'), '')
  }
  return out
}

/** Drop control characters and whitespace, the classic scheme-smuggling trick. */
function squash(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x20)
    .join('')
}

/** `#fragment` stays (same-document reference); inert image data URLs stay. */
function isSafeUrlValue(value: string): boolean {
  // Control characters and whitespace are dropped outright: `java\tscript:` is
  // the classic way to smuggle a scheme past a naive prefix check.
  const trimmed = squash(value)
  if (trimmed === '') return true
  if (trimmed.startsWith('#')) return true
  if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(trimmed)) return true
  return false
}

function isSafeStyleValue(value: string): boolean {
  // Whitespace and control characters go first, so `expr\tession(` and
  // `java\nscript:` are caught by the same substring checks as the plain form.
  const lowered = squash(value).toLowerCase()
  if (
    lowered.includes('expression(') ||
    lowered.includes('javascript:') ||
    lowered.includes('@import')
  ) {
    return false
  }
  if (!lowered.includes('url(')) return true
  // Only same-document references survive inside `url()`.
  return /url\(['"]?#/.test(lowered) && !/url\(['"]?[^#'")]/.test(lowered)
}

function sanitizeAttributes(raw: string, element: string): string {
  const kept: string[] = []
  ATTR_RE.lastIndex = 0
  for (;;) {
    const match = ATTR_RE.exec(raw)
    if (!match) break
    const name = match[1]
    if (!name) continue
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    const lowerName = name.toLowerCase()

    if (lowerName.startsWith('on')) continue
    if (URL_ATTRIBUTES.has(lowerName) && !isSafeUrlValue(value)) continue
    if (lowerName === 'style' && !isSafeStyleValue(value)) continue
    if (lowerName === 'xlink:base' || lowerName === 'xml:base') continue
    // An animation writes its value into another attribute, so `to`/`from`/
    // `values`/`by` are held to the same URL rules as a style value whatever
    // the target attribute is.
    if (
      ANIMATION_ELEMENTS.has(element) &&
      ANIMATION_VALUE_ATTRIBUTES.has(localName(lowerName)) &&
      (!isSafeStyleValue(value) || /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(squash(value)))
    ) {
      continue
    }

    const hasValue = match[2] !== undefined || match[3] !== undefined || match[4] !== undefined
    kept.push(hasValue ? `${name}="${value.replace(/"/g, '&quot;')}"` : name)
  }
  return kept.length > 0 ? ` ${kept.join(' ')}` : ''
}

/**
 * Strip every scripting, external-reference and entity construct from an SVG.
 *
 * @returns the sanitized markup, or `null` when no `<svg` root survives.
 */
export function sanitizeSvg(input: string | Buffer): string | null {
  let svg = typeof input === 'string' ? input : input.toString('utf8')

  svg = svg
    .replace(COMMENT_RE, '')
    .replace(DOCTYPE_RE, '')
    .replace(ENTITY_RE, '')
    .replace(PI_RE, '')
    .replace(CDATA_RE, '')

  svg = stripForbiddenElements(svg)
  svg = stripUnsafeStyleElements(svg)

  svg = svg.replace(TAG_RE, (whole, name: string, attrs: string, selfClosing: string) => {
    const local = localName(name)
    // Backstop for anything the paired-form pass could not match.
    if (FORBIDDEN_LOCAL_NAMES.has(local)) return ''
    if (UNWRAPPED_ELEMENTS.has(local)) return ''
    if (whole.startsWith('</')) return `</${name}>`
    // `<animate attributeName="href">` swaps a reference after load; the whole
    // animation element goes rather than trying to keep half of it.
    if (/\battributeName\s*=\s*["']?(?:xlink:)?(?:href|src)\b/i.test(attrs)) return ''
    return `<${name}${sanitizeAttributes(attrs, local)}${selfClosing ? '/' : ''}>`
  })

  if (!new RegExp(`<${TAG_PREFIX}svg[\\s/>]`, 'i').test(svg)) return null
  return svg
}

/** Sanitize icon bytes, returning `null` when nothing usable survives. */
export function sanitizeSvgBytes(bytes: Buffer): Buffer | null {
  const sanitized = sanitizeSvg(bytes)
  return sanitized === null ? null : Buffer.from(sanitized, 'utf8')
}
