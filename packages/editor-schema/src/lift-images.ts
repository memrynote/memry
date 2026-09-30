/**
 * An image inside a paragraph or a heading has nowhere to go in the editor:
 * outside a table cell an image is a block, so ProseMirror drops an `<img>` it
 * meets inside a text block, and a house-style write-back then deletes it from
 * the file (#2537). Importers write this shape (`Caption ![i](u)`,
 * `## [![i](u)](l)`), so the images are moved out of the text block in the HTML
 * the markdown parses to, each into a block of its own right after it.
 *
 * Only top-level `<p>` and `<h1>`..`<h6>` are touched. A paragraph holding
 * nothing but images already parses to image blocks, so it is left as it is.
 * A link wrapped around nothing but an image stays in the text block with the
 * image's alt text (or, without one, its target) as its label, so the target
 * is kept.
 */

const TAG = /<!--[\s\S]*?-->|<(\/?)([a-z][a-z0-9-]*)\b[^>]*>/gi

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

const IMAGE = /([ \t]*)(?:<a\b([^>]*)>\s*(<img\b[^>]*>)\s*<\/a>|(<img\b[^>]*>))([ \t]*)/gi
const ANY_TAG = /<[^>]*>/g
const ALT_ATTRIBUTE = /\salt="([^"]*)"/i
const HREF_ATTRIBUTE = /\shref="([^"]*)"/i

/** The HTML with every lifted image moved, or null when there was none to lift. */
export function liftImagesOutOfTextBlocks(html: string): string | null {
  let out = ''
  let copied = 0
  let depth = 0
  let block: { tag: string; innerStart: number } | null = null

  for (const match of html.matchAll(TAG)) {
    const [token, closing, rawTag] = match
    if (!rawTag) continue
    const tag = rawTag.toLowerCase()
    if (VOID_TAGS.has(tag)) continue
    if (!closing) {
      if (depth === 0 && TEXT_BLOCK_TAG.test(tag)) {
        block = { tag, innerStart: match.index + token.length }
      }
      depth++
      continue
    }
    depth = Math.max(0, depth - 1)
    if (depth > 0) continue
    if (block?.tag === tag) {
      const split = splitImagesOut(html.slice(block.innerStart, match.index), tag !== 'p')
      if (split) {
        out += html.slice(copied, block.innerStart) + split.text + token + split.images.join('')
        copied = match.index + token.length
      }
    }
    block = null
  }

  return copied === 0 ? null : out + html.slice(copied)
}

function splitImagesOut(
  inner: string,
  liftWhenAlone: boolean
): { text: string; images: string[] } | null {
  if (!/<img\b/i.test(inner)) return null
  if (!liftWhenAlone && !/\S/.test(inner.replace(IMAGE, '').replace(ANY_TAG, ''))) return null

  const images: string[] = []
  const text = inner.replace(
    IMAGE,
    (
      found: string,
      before: string,
      linkAttributes: string | undefined,
      linkedImage: string | undefined,
      image: string | undefined,
      after: string,
      offset: number
    ) => {
      if (linkedImage !== undefined && linkAttributes !== undefined) {
        images.push(linkedImage)
        const label =
          ALT_ATTRIBUTE.exec(linkedImage)?.[1] || HREF_ATTRIBUTE.exec(linkAttributes)?.[1]
        return label ? `${before}<a${linkAttributes}>${label}</a>${after}` : before + after
      }
      images.push(image ?? '')
      const atEdge = offset === 0 || offset + found.length === inner.length
      return !atEdge && (before || after) ? ' ' : ''
    }
  )
  return { text, images }
}
