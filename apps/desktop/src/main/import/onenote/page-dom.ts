/**
 * DOM-level transforms for OneNote page HTML (after the pure string pre-pass,
 * before the shared HTML→markdown walker).
 *
 * OneNote encodes meaning in attributes and inline styles the walker cannot
 * see: `data-tag` note tags/to-dos, Consolas-styled code runs, style-only
 * bold/italic/strikethrough/highlight spans, `onenote:` internal links,
 * MathML equations, and `<object>`/`<img>`/`<iframe>` attachment references.
 * Each transform here rewrites those into elements the walker understands.
 *
 * All functions mutate the given body element in place.
 *
 * @module main/import/onenote/page-dom
 */

import { mathmlToLatex } from '@memry/importers/onenote'

/**
 * OneNote OCR alt text can be huge; keep a short, markdown-safe excerpt.
 * Unicode-aware so non-Latin OCR (Turkish, Japanese, Cyrillic…) survives —
 * only the characters that would break `![alt](url)` are dropped.
 */
export function sanitizeOcrText(text: string): string {
  const cleaned = text
    .replace(/[^\p{L}\p{N}\s.,!?-]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > 50 ? `${cleaned.substring(0, 50)}…` : cleaned
}

/**
 * Graph serves page images and attachments as authenticated resource URLs on
 * its own host. Any other host in the page HTML (a linked or web-clipped
 * image) must never receive the Microsoft access token, so those references
 * are left in place untouched rather than downloaded.
 */
export function isGraphResourceUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname.toLowerCase() === 'graph.microsoft.com'
  } catch {
    return false
  }
}

// ============================================================================
// Tags + to-dos (`data-tag`)
// ============================================================================

/**
 * Convert `data-tag` attributes: to-do variants become markdown task prefixes
 * on the element, every other tag is collected for the note's frontmatter.
 *
 * @returns The distinct non-todo tag names (`:` → `-`, OneNote's own format is
 *   otherwise already tag-safe).
 */
export function convertOneNoteTags(body: Element): string[] {
  const tags = new Set<string>()
  for (const element of Array.from(body.querySelectorAll('[data-tag]'))) {
    const value = element.getAttribute('data-tag')
    if (!value) continue
    element.removeAttribute('data-tag')

    for (const part of value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean)) {
      if (part.startsWith('to-do')) {
        const completed = part === 'to-do:completed'
        if (element.nodeName === 'LI') {
          // The walker renders list items itself, marker included. Give it the
          // checkbox it looks for instead of literal text, or the item comes
          // out double-marked (`- - [ ] Task`).
          const box = element.ownerDocument.createElement('input')
          box.setAttribute('type', 'checkbox')
          if (completed) box.setAttribute('checked', '')
          element.prepend(box)
        } else {
          // Prepend a text node so nested elements (e.g. an image marked as
          // to-do) are preserved after the walker flattens the paragraph.
          element.prepend(`- ${completed ? '[x]' : '[ ]'} `)
        }
      } else {
        tags.add(part.replace(/:/g, '-'))
      }
    }
  }
  return [...tags]
}

// ============================================================================
// Internal links, videos, math
// ============================================================================

/**
 * `onenote:` links point into the local OneNote install and would be dead in
 * Memry — unwrap them to their text.
 */
export function convertInternalLinks(body: Element): void {
  for (const link of Array.from(body.querySelectorAll('a'))) {
    const href = link.getAttribute('href') ?? ''
    if (href.toLowerCase().startsWith('onenote:')) {
      link.replaceWith(link.ownerDocument.createTextNode(link.textContent ?? ''))
    }
  }
}

/**
 * OneNote embeds online videos as `<iframe>`s. Emit a markdown link (the
 * walker passes text through verbatim); other iframes become plain anchors.
 */
export function convertVideoEmbeds(body: Element): void {
  for (const frame of Array.from(body.querySelectorAll('iframe'))) {
    const src = frame.getAttribute('src') ?? ''
    if (!src) {
      frame.remove()
      continue
    }
    const doc = frame.ownerDocument
    if (/youtube\.com|youtu\.be|vimeo\.com/i.test(src)) {
      frame.replaceWith(doc.createTextNode(`[Embedded video](${src})`))
    } else {
      const anchor = doc.createElement('a')
      anchor.setAttribute('href', src)
      anchor.textContent = src
      frame.replaceWith(anchor)
    }
  }
}

/** Convert `<math>` (MathML) elements to inline `$LaTeX$` text. */
export function convertMathToLatex(body: Element): void {
  for (const mathEl of Array.from(body.querySelectorAll('math'))) {
    const doc = mathEl.ownerDocument
    const latex = mathmlToLatex(mathEl.outerHTML)
    if (latex) {
      // OneNote marks these display="block", but inline form reads fine and
      // avoids stray blank lines from the surrounding <br> wrappers.
      mathEl.replaceWith(doc.createTextNode(`$${latex}$`))
    } else {
      mathEl.replaceWith(doc.createTextNode(mathEl.textContent ?? ''))
    }
  }
}

// ============================================================================
// Code (Consolas-styled runs → <code> / <pre>)
// ============================================================================

function isHtmlElement(node: Node | null): node is HTMLElement {
  return node !== null && node.nodeType === 1
}

function isCode(node: Node | null): node is HTMLElement {
  if (!isHtmlElement(node)) return false
  return (node.style?.fontFamily ?? '').includes('Consolas')
}

function isBr(node: Node | null): node is Element {
  return node !== null && node.nodeName === 'BR'
}

/** True iff node is a paragraph containing only code spans / line breaks. */
function isCodeParagraph(node: Node | null): node is HTMLElement {
  return (
    node !== null &&
    node.nodeName === 'P' &&
    node.childNodes.length > 0 &&
    Array.from(node.childNodes).every(
      (child) =>
        isCode(child) ||
        isBr(child) ||
        (child.nodeType === 3 && (child.textContent ?? '').trim() === '')
    )
  )
}

/**
 * OneNote separates consecutive code lines into `<p>` blocks divided by a
 * `<br>`; merge those runs so one fenced block comes out, not many.
 */
export function mergeCodeParagraphs(body: Element): void {
  const paragraphs = Array.from(body.querySelectorAll('p')).reverse()
  for (const paragraph of paragraphs) {
    if (!paragraph.isConnected || !isCodeParagraph(paragraph)) continue
    const lineBreak = paragraph.nextElementSibling
    if (!lineBreak || !isBr(lineBreak)) continue
    const next = lineBreak.nextElementSibling
    if (!isCodeParagraph(next)) continue

    // The <br> between the paragraphs is one newline inside the block.
    paragraph.appendChild(lineBreak)
    paragraph.append(...Array.from(next.childNodes))
    next.remove()
  }
}

/**
 * Replace Consolas runs with real `<code>` (single inline span) or `<pre>`
 * (anything longer) elements so the shared walker renders inline code and
 * fenced blocks.
 */
export function convertCodeRuns(body: Element): void {
  const doc = body.ownerDocument
  for (const element of Array.from(body.querySelectorAll('*'))) {
    if (!element.isConnected || !isCode(element)) continue

    // Gather the run of code/br siblings that belong to the same block.
    const run: Element[] = []
    let sibling = element.nextSibling
    while (isCode(sibling) || isBr(sibling)) {
      run.push(sibling)
      sibling = sibling.nextSibling
    }
    // Trim trailing <br>s — the block should end on code.
    while (run.length > 0 && isBr(run[run.length - 1])) run.pop()

    const text = element.textContent ?? ''
    const standalone = run.length === 0 && !text.includes('\n')

    if (standalone && element.nodeName === 'SPAN') {
      const codeEl = doc.createElement('code')
      codeEl.textContent = text
      element.replaceWith(codeEl)
      continue
    }

    let blockText = text
    for (const part of run) {
      blockText += part.nodeName === 'BR' ? '\n' : (part.textContent ?? '')
    }
    for (const part of run) part.remove()

    const pre = doc.createElement('pre')
    pre.textContent = blockText
    element.replaceWith(pre)

    // The walker treats <p> children as inline; a fence trapped inside a
    // paragraph would lose its block form. When the paragraph holds nothing
    // but this code block, promote the <pre> to replace it.
    const parent = pre.parentElement
    if (
      parent &&
      parent.nodeName === 'P' &&
      Array.from(parent.childNodes).every((child: ChildNode) => {
        if (child === (pre as Node)) return true
        return child.nodeType === 3 && (child.textContent ?? '').trim() === ''
      })
    ) {
      parent.replaceWith(pre)
    }
  }
}

// ============================================================================
// Styled spans → semantic elements
// ============================================================================

/**
 * OneNote expresses bold/italic/strikethrough/highlight as inline styles the
 * walker cannot interpret; rewrite them into semantic tags. Table cells only
 * lose their style attribute (a styled `<td>` must stay a `<td>`).
 */
export function convertStyledElements(body: Element): void {
  const doc = body.ownerDocument
  const styleMap: [string, string][] = [
    ['font-weight:bold', 'b'],
    ['font-style:italic', 'i'],
    ['text-decoration:line-through', 's'],
    ['background-color', 'mark']
  ]
  /** Elements that exist only to carry styling and can be unwrapped. */
  const STYLE_CARRIERS = new Set(['SPAN', 'FONT'])

  for (const element of Array.from(body.querySelectorAll('[style]'))) {
    if (!element.isConnected) continue
    if (element.nodeName === 'TD' || element.nodeName === 'TH') {
      element.removeAttribute('style')
      continue
    }
    if (element.nodeName === 'PRE' || element.nodeName === 'CODE') continue

    const style = (element.getAttribute('style') ?? '').replace(/\s/g, '')
    element.removeAttribute('style')
    const matches = styleMap.filter(
      ([needle]) => style.includes(needle) && (needle !== 'background-color' || isHighlight(style))
    )
    if (matches.length === 0) continue

    // Nest one element per matching style so a combined run (bold + highlight)
    // keeps every mark instead of only the first.
    const outer = doc.createElement(matches[0][1])
    let innermost = outer
    for (const [, tag] of matches.slice(1)) {
      const next = doc.createElement(tag)
      innermost.appendChild(next)
      innermost = next
    }
    innermost.append(...Array.from(element.childNodes))

    if (STYLE_CARRIERS.has(element.nodeName)) {
      element.replaceWith(outer)
    } else {
      // Keep the original element: an <li> replaced by <mark> drops out of its
      // list (the walker only renders `li` children) and an <a> loses its href.
      element.appendChild(outer)
    }
  }
}

/** True when a `background-color` declaration is an actual highlight. Pasted
 * OneNote content routinely carries an explicit white/transparent background,
 * which must not become `==highlighted==` text. */
function isHighlight(style: string): boolean {
  const value = style.match(/background-color:([^;]+)/)?.[1]?.toLowerCase()
  if (!value) return false
  return ![
    'transparent',
    'white',
    '#fff',
    '#ffffff',
    'rgb(255,255,255)',
    'rgba(255,255,255,1)',
    'inherit',
    'initial',
    'unset',
    'none'
  ].includes(value)
}

// ============================================================================
// Attachment collection (downloads happen in the importer)
// ============================================================================

/** An `<img>` reference to download and rewrite. */
export interface OneNoteImageRef {
  el: Element
  /** Authenticated Graph resource URL (full-res preferred). */
  url: string
  /** MIME type as reported by OneNote (e.g. `image/png`). */
  mime: string | null
  /** OCR/alt text, already sanitized. */
  alt: string
}

/** An `<object data-attachment>` file reference to download and replace. */
export interface OneNoteFileRef {
  el: Element
  originalName: string
  /** Authenticated Graph resource URL. */
  url: string
}

/**
 * Collect embedded file attachments (`<object data-attachment>`). Child nodes
 * are hoisted out first so content nested inside an object survives whatever
 * the importer decides to do with the element.
 */
export function collectFileAttachments(body: Element): OneNoteFileRef[] {
  const refs: OneNoteFileRef[] = []
  for (const object of Array.from(body.querySelectorAll('object'))) {
    // Hoist in document order: a fragment keeps the children's relative order,
    // where repeated insertBefore(firstChild, object.nextSibling) reverses it.
    const hoisted = object.ownerDocument.createDocumentFragment()
    while (object.firstChild) hoisted.appendChild(object.firstChild)
    object.parentNode?.insertBefore(hoisted, object.nextSibling)

    const originalName = object.getAttribute('data-attachment')
    const url = object.getAttribute('data')
    if (!originalName || !url || !isGraphResourceUrl(url)) {
      object.remove()
      continue
    }
    refs.push({ el: object, originalName, url })
  }
  return refs
}

/**
 * Collect remote images that live on Graph (authenticated resource URLs).
 * Data-URI images were already lifted by the pure `extractDataImages` pass,
 * and images hosted anywhere else are left as plain external references so the
 * import never sends the Microsoft token off-host.
 */
export function collectRemoteImages(body: Element): OneNoteImageRef[] {
  const refs: OneNoteImageRef[] = []
  for (const image of Array.from(body.querySelectorAll('img'))) {
    const fullres = image.getAttribute('data-fullres-src')
    const src = fullres && isGraphResourceUrl(fullres) ? fullres : (image.getAttribute('src') ?? '')
    if (!isGraphResourceUrl(src)) continue

    const rawAlt = image.getAttribute('alt') ?? ''
    refs.push({
      el: image,
      url: src,
      mime:
        image.getAttribute('data-fullres-src-type') ?? image.getAttribute('data-src-type') ?? null,
      alt: /^data:/i.test(rawAlt) ? '' : sanitizeOcrText(rawAlt)
    })
  }
  return refs
}

/** Elements the shared walker renders inline, so a block placed inside one
 * would not start its own line. */
const INLINE_CONTAINERS = new Set([
  'P',
  'SPAN',
  'A',
  'B',
  'I',
  'EM',
  'STRONG',
  'MARK',
  'U',
  'S',
  'FONT',
  'SMALL',
  'SUB',
  'SUP',
  'CITE',
  'LABEL'
])

/**
 * Replace a collected element with a paragraph of `text` placed at block level.
 *
 * A file-block marker only renders when it is alone on its line, and the shared
 * walker renders a `<p>` nested inside a `<p>` inline — so the paragraph is
 * inserted after the outermost inline ancestor rather than in place.
 */
export function replaceWithParagraphText(el: Element, text: string): void {
  const paragraph = el.ownerDocument.createElement('p')
  paragraph.textContent = text

  let anchor: Element = el
  while (anchor.parentElement && INLINE_CONTAINERS.has(anchor.parentElement.nodeName)) {
    anchor = anchor.parentElement
  }
  anchor.parentNode?.insertBefore(paragraph, anchor.nextSibling)
  el.remove()
}
