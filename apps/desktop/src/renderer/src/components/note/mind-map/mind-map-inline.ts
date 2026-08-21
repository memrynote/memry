/**
 * Private helper — a block's inline content becomes a label and its tags.
 *
 * Not exported outside this directory. Two things come out of one walk because
 * they are decided by the same pass: a hash tag becomes a badge on the node, so
 * it must leave the label at exactly the point it is collected, or the tag
 * would be shown twice.
 *
 * Every inline spec Memry registers is content-less (`content: 'none'`) and
 * keeps its visible text in props, so the reader below is prop-driven rather
 * than a switch over node types: it works the same for a spec added later.
 */

/**
 * Where a content-less inline spec keeps its text, best first.
 *
 * - `wikiLink` → `alias`, else `target`
 * - `linkMention` → `title`, else `domain`, else `url`
 * - `inlineImage` → `alt` (a picture with no alt text contributes nothing)
 * - `dateMention` → `dateISO`, the only date form available without the
 *   renderer's clock and week-start settings
 *
 * `hashTag`'s `tag` is deliberately absent: a tag is a badge, not label text.
 */
const INLINE_LABEL_PROPS = ['alias', 'target', 'title', 'alt', 'domain', 'url', 'dateISO'] as const

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A prop read as a non-empty trimmed string, or `null`. */
export function stringProp(props: unknown, key: string): string | null {
  if (!isRecord(props)) return null
  const value = props[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export interface InlineRead {
  text: string
  /** In document order, first occurrence wins, `#` already stripped. */
  tags: string[]
}

/** Total: any inline shape in, a label and its tags out. */
export function readInline(value: unknown): InlineRead {
  const tags: string[] = []
  const seen = new Set<string>()

  const walk = (node: unknown): string => {
    if (typeof node === 'string') return node
    if (Array.isArray(node)) return node.map(walk).join('')
    if (!isRecord(node)) return ''

    // A tag leaves the label here and reappears as a badge on the node. The
    // stored prop has no `#`; the badge adds one back so it reads as written.
    if (node.type === 'hashTag') {
      const tag = stringProp(node.props, 'tag')
      if (tag !== null && !seen.has(tag)) {
        seen.add(tag)
        tags.push(tag)
      }
      return ''
    }

    if (typeof node.text === 'string') return node.text
    if (node.content !== undefined) return walk(node.content)

    for (const key of INLINE_LABEL_PROPS) {
      const candidate = stringProp(node.props, key)
      if (candidate !== null) return candidate
    }
    return ''
  }

  return { text: walk(value), tags }
}

/** Collapses runs of whitespace so a wrapped label measures predictably. */
export function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}
