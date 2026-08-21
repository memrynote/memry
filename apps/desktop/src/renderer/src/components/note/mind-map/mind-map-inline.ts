/**
 * Private helper — a block's inline content becomes a label, its tags and the
 * wiki links written inside it.
 *
 * Not exported outside this directory. Three things come out of one walk
 * because they are decided by the same pass: a hash tag becomes a badge and a
 * wiki link becomes a node of its own, so both must leave the label at exactly
 * the point they are collected, or each would be shown twice.
 *
 * Every inline spec Memry registers is content-less (`content: 'none'`) and
 * keeps its visible text in props, so the reader below is prop-driven rather
 * than a switch over node types: it works the same for a spec added later.
 */

/**
 * Where a content-less inline spec keeps its text, best first.
 *
 * - `linkMention` → `title`, else `domain`, else `url`
 * - `inlineImage` → `alt` (a picture with no alt text contributes nothing)
 * - `dateMention` → `dateISO`, the only date form available without the
 *   renderer's clock and week-start settings
 *
 * `hashTag`'s `tag` and `wikiLink`'s `target`/`alias` are deliberately absent:
 * a tag is a badge and a wiki link is a branch, neither is label text.
 */
const INLINE_LABEL_PROPS = ['title', 'alt', 'domain', 'url', 'dateISO'] as const

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

/** One `[[wiki link]]`, as the map needs to draw it and to open it. */
export interface InlineWikiLink {
  /** The target exactly as written — `Roadmap`, `Roadmap#Q3`, `diagram.pdf`. */
  target: string
  /** What the note shows for it: its alias when it has one, else the target. */
  label: string
}

export interface InlineRead {
  text: string
  /** In document order, first occurrence wins, `#` already stripped. */
  tags: string[]
  /** In document order, first occurrence of each target-and-label pair wins. */
  links: InlineWikiLink[]
}

/** Total: any inline shape in, a label, its tags and its wiki links out. */
export function readInline(value: unknown): InlineRead {
  const tags: string[] = []
  const seen = new Set<string>()
  const links: InlineWikiLink[] = []
  const seenLinks = new Set<string>()

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

    // A wiki link leaves the label here and reappears as a node of its own. The
    // pair is what dedupes, not the target alone: `[[A|first]]` and
    // `[[A|second]]` in one sentence are two things the note says.
    if (node.type === 'wikiLink') {
      const target = stringProp(node.props, 'target')
      if (target !== null) {
        const label = stringProp(node.props, 'alias') ?? target
        // A separator no target or alias can contain, so `[[A B|C]]` and
        // `[[A|B C]]` stay two distinct links rather than one.
        const signature = `${target}\u0000${label}`
        if (!seenLinks.has(signature)) {
          seenLinks.add(signature)
          links.push({ target, label })
        }
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

  return { text: walk(value), tags, links }
}

/** Collapses runs of whitespace so a wrapped label measures predictably. */
export function normalizeLabel(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}
