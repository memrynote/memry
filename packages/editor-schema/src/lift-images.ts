/**
 * An image inside a paragraph or a heading has nowhere to go in the editor:
 * outside a table cell an image is a block, so ProseMirror drops an `<img>` it
 * meets inside a text block, and a house-style write-back then deletes it from
 * the file (#2537). Importers write this shape (`Caption ![i](u)`,
 * `## [![i](u)](l)`), so the images are moved out of the text block in the HTML
 * the markdown parses to, each into a block of its own right after it.
 *
 * Only top-level `<p>` and `<h1>`..`<h6>` are touched, and with `listItems` a
 * list item's `<p>`, whose images become the item's child blocks. A paragraph
 * holding nothing but images already parses to image blocks, so it is left as
 * it is.
 * A link wrapped around nothing but an image stays in the text block with the
 * image's alt text (or, without one, its target) as its label, so the target
 * is kept.
 */

const TAG_HEAD = /<(\/?)([a-z][a-z0-9-]*)\b/iy

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr'
])

const TEXT_BLOCK_TAG = /^(?:p|h[1-6])$/

const LINK_HEAD = /<a\b/iy
const IMAGE_HEAD = /<img\b/iy
const BLANK = /[ \t]/
const ALT_ATTRIBUTE = /\salt="([^"]*)"/i
const HREF_ATTRIBUTE = /\shref="([^"]*)"/i

/** The HTML with every lifted image moved, or null when there was none to lift. */
export function liftImagesOutOfTextBlocks(html: string, listItems: boolean): string | null {
  let out = ''
  let copied = 0
  const open: string[] = []
  let block: { tag: string; innerStart: number; depth: number } | null = null

  for (const { index, token, closing, rawTag } of htmlTags(html)) {
    const tag = rawTag.toLowerCase()
    if (VOID_TAGS.has(tag)) continue
    if (!closing) {
      const inItem = listItems && tag === 'p' && open.at(-1) === 'li'
      if (!block && TEXT_BLOCK_TAG.test(tag) && (open.length === 0 || inItem)) {
        block = { tag, innerStart: index + token.length, depth: open.length }
      }
      open.push(tag)
      continue
    }
    open.pop()
    if (block?.depth !== open.length) continue
    if (block.tag === tag) {
      const split = splitImagesOut(html.slice(block.innerStart, index), tag !== 'p')
      if (split) {
        out += html.slice(copied, block.innerStart) + split.text + token + split.images.join('')
        copied = index + token.length
      }
    }
    block = null
  }

  return copied === 0 ? null : out + html.slice(copied)
}

interface HtmlTag {
  index: number
  token: string
  closing: string
  rawTag: string
}

/**
 * Every start and end tag of `html`, in order. A comment is skipped, and a `<`
 * that opens no tag is text. A tag runs to the first `>` after its name, so with
 * none left no later tag closes either.
 */
function* htmlTags(html: string): Generator<HtmlTag> {
  let commentCloses = true
  let at = html.indexOf('<')
  while (at !== -1) {
    let next = at + 1
    if (html.startsWith('<!--', at)) {
      const close = commentCloses ? html.indexOf('-->', at + 4) : -1
      if (close === -1) commentCloses = false
      else next = close + 3
    } else {
      TAG_HEAD.lastIndex = at
      const head = TAG_HEAD.exec(html)
      if (head) {
        const end = html.indexOf('>', TAG_HEAD.lastIndex)
        if (end === -1) return
        yield { index: at, token: html.slice(at, end + 1), closing: head[1], rawTag: head[2] }
        next = end + 1
      }
    }
    at = html.indexOf('<', next)
  }
}

interface ImageMatch {
  start: number
  end: number
  before: string
  after: string
  /** The `<img>`, and the attributes of the `<a>` around it when there is one. */
  image: string
  linkAttributes?: string
}

/** The first `>` at or after `from` among the sorted `gts`, or -1. */
function nextGt(gts: number[], from: number): number {
  let low = 0
  let high = gts.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (gts[mid] < from) low = mid + 1
    else high = mid
  }
  return low < gts.length ? gts[low] : -1
}

function skipSpace(text: string, from: number): number {
  let at = from
  while (at < text.length && /\s/.test(text[at])) at++
  return at
}

/**
 * Each image of `html` with the blanks around it, left to right: `<img>`, or
 * `<a>` holding nothing but an `<img>`. Every tag is read through the `>` that
 * ends it, found by position, and what follows an `<a>` is read once per `>`
 * however many `<a` lead to it, so a long run of unfinished tags costs no more
 * than their length.
 */
function findImages(html: string): ImageMatch[] {
  const gts: number[] = []
  for (let gt = html.indexOf('>'); gt !== -1; gt = html.indexOf('>', gt + 1)) gts.push(gt)
  const linkTails = new Map<number, { image: string; end: number } | null>()
  const found: ImageMatch[] = []
  let last = 0

  for (let at = html.indexOf('<'); at !== -1; at = html.indexOf('<', at + 1)) {
    let linkAttributes: string | undefined
    let image: string
    let end: number
    LINK_HEAD.lastIndex = at
    IMAGE_HEAD.lastIndex = at
    if (LINK_HEAD.test(html)) {
      const gt = nextGt(gts, at + 2)
      if (gt === -1) continue
      if (!linkTails.has(gt)) linkTails.set(gt, readLinkTail(html, gts, gt + 1))
      const tail = linkTails.get(gt)
      if (!tail) continue
      linkAttributes = html.slice(at + 2, gt)
      image = tail.image
      end = tail.end
    } else if (IMAGE_HEAD.test(html)) {
      const gt = nextGt(gts, at + 4)
      if (gt === -1) continue
      image = html.slice(at, gt + 1)
      end = gt + 1
    } else {
      continue
    }
    let start = at
    while (start > last && BLANK.test(html[start - 1])) start--
    let after = end
    while (after < html.length && BLANK.test(html[after])) after++
    found.push({
      start,
      end: after,
      before: html.slice(start, at),
      after: html.slice(end, after),
      image,
      linkAttributes
    })
    last = after
    at = after - 1
  }
  return found
}

/** What closes an `<a>` that opened before `from`: `\s* <img …> \s* </a>`. */
function readLinkTail(
  html: string,
  gts: number[],
  from: number
): { image: string; end: number } | null {
  const imageAt = skipSpace(html, from)
  IMAGE_HEAD.lastIndex = imageAt
  if (!IMAGE_HEAD.test(html)) return null
  const gt = nextGt(gts, imageAt + 4)
  if (gt === -1) return null
  const closeAt = skipSpace(html, gt + 1)
  if (html.slice(closeAt, closeAt + 4).toLowerCase() !== '</a>') return null
  return { image: html.slice(imageAt, gt + 1), end: closeAt + 4 }
}

/** `text` without its `<…>` runs. */
function stripTags(text: string): string {
  let out = ''
  let copied = 0
  for (let at = text.indexOf('<'); at !== -1; at = text.indexOf('<', copied)) {
    const end = text.indexOf('>', at + 1)
    if (end === -1) break
    out += text.slice(copied, at)
    copied = end + 1
  }
  return out + text.slice(copied)
}

function splitImagesOut(
  inner: string,
  liftWhenAlone: boolean
): { text: string; images: string[] } | null {
  if (!/<img\b/i.test(inner)) return null
  const matches = findImages(inner)
  if (!liftWhenAlone) {
    let rest = ''
    let copied = 0
    for (const { start, end } of matches) {
      rest += inner.slice(copied, start)
      copied = end
    }
    if (!/\S/.test(stripTags(rest + inner.slice(copied)))) return null
  }

  const images: string[] = []
  let text = ''
  let copied = 0
  for (const { start, end, before, after, image, linkAttributes } of matches) {
    text += inner.slice(copied, start)
    copied = end
    images.push(image)
    if (linkAttributes !== undefined) {
      const label = ALT_ATTRIBUTE.exec(image)?.[1] || HREF_ATTRIBUTE.exec(linkAttributes)?.[1]
      text += label ? `${before}<a${linkAttributes}>${label}</a>${after}` : before + after
      continue
    }
    const atEdge = start === 0 || end === inner.length
    text += !atEdge && (before || after) ? ' ' : ''
  }
  return { text: text + inner.slice(copied), images }
}
