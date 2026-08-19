/**
 * `wikiLink` inline content spec.
 *
 * Lives here rather than in the renderer because the main process needs the
 * same node: a spec the main-process schema does not carry is not a rendering
 * gap, it is data loss — y-prosemirror deletes any element it cannot build,
 * straight out of the shared Y.Doc. Fully portable (vanilla DOM, no renderer
 * imports); the node, its props and its on-disk form are shared, and only the
 * HTML-paste `parse` rule differs (see `WikiLinkSerializationOnly` below).
 */

import { createInlineContentSpec, type InlineContentSpec } from '@blocknote/core'

const WIKI_LINK_FULL_PATTERN = /^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/

export interface WikiLinkParts {
  target: string
  alias: string
}

export function parseWikiLinkText(text: string): WikiLinkParts | null {
  const match = text.trim().match(WIKI_LINK_FULL_PATTERN)
  if (!match) return null

  const target = match[1]?.trim()
  const alias = match[2]?.trim() ?? ''

  if (!target) return null
  return { target, alias }
}

/**
 * The marks a wiki link can carry, named exactly as BlockNote names them in its
 * style schema — `bold` / `italic` / `underline` / `strike` / `code` /
 * `textColor` / `backgroundColor`. That is the whole of `defaultStyleSpecs`;
 * read it there, not from a brief (it is `strike`, never `strikethrough`, and
 * `underline` is real).
 *
 * They are PROPS rather than styles because BlockNote's data model gives custom
 * inline content no `styles` field at all — `CustomInlineContentFromConfig` is
 * `{ type, props, content }`. Promoting `**[[A]]**` into a node therefore had
 * nowhere to put the bold, and the mark was lost in the shared document before
 * the vault file was ever written (#1439).
 */
export interface WikiLinkMarkProps {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
  textColor: string
  backgroundColor: string
}

/**
 * Reads a BlockNote `styles` object as wiki-link mark props, keeping only the
 * marks that are actually set. Defaults are omitted rather than written out, so
 * a link promoted from unstyled text is `{ target, alias }` exactly as before.
 */
export function wikiLinkMarkProps(
  styles?: Record<string, unknown> | null
): Partial<WikiLinkMarkProps> {
  if (!styles) return {}

  const props: Partial<WikiLinkMarkProps> = {}
  if (styles.bold === true) props.bold = true
  if (styles.italic === true) props.italic = true
  if (styles.underline === true) props.underline = true
  if (styles.strike === true) props.strike = true
  if (styles.code === true) props.code = true
  if (typeof styles.textColor === 'string' && styles.textColor !== 'default') {
    props.textColor = styles.textColor
  }
  if (typeof styles.backgroundColor === 'string' && styles.backgroundColor !== 'default') {
    props.backgroundColor = styles.backgroundColor
  }
  return props
}

/** Whether a run's styles carry any mark a wiki link would have to take with it. */
export function hasWikiLinkMarks(styles?: Record<string, unknown> | null): boolean {
  return Object.keys(wikiLinkMarkProps(styles)).length > 0
}

export function createWikiLinkInlineContent(
  target: string,
  alias: string,
  styles?: Record<string, unknown> | null
) {
  return {
    type: 'wikiLink',
    props: { target, alias: alias ?? '', ...wikiLinkMarkProps(styles) }
  }
}

/**
 * The mark props are ADDITIVE and every one of them has a default, which is the
 * whole compat plan for a node type already sitting in production documents:
 *
 * - A `wikiLink` element persisted by an older build carries no mark attributes
 *   at all. ProseMirror's `computeAttrs` walks the SCHEMA's attrs and fills a
 *   default for every key the element lacks, so the node still builds and still
 *   serializes to `[[target]]` — no migration, no rewrite.
 * - An older build meeting a node that DOES carry them ignores them the same
 *   way: `computeAttrs` iterates the schema, so keys it has never heard of are
 *   dropped on the floor rather than throwing (`_checkAttrs`, which does throw,
 *   is not on the `NodeType.create` path y-prosemirror uses). The link renders
 *   as it always has. Editing that paragraph on the old build then strips the
 *   attributes from the shared doc — y-prosemirror's `updateYFragment` removes
 *   any Y attribute absent from the ProseMirror node — which lands exactly on
 *   the pre-#1439 behaviour: the mark is forgotten. A downgrade cannot corrupt,
 *   only forget.
 */
export const wikiLinkConfig = {
  type: 'wikiLink' as const,
  propSchema: {
    target: { default: '' },
    alias: { default: '' },
    bold: { default: false },
    italic: { default: false },
    underline: { default: false },
    strike: { default: false },
    code: { default: false },
    textColor: { default: 'default' },
    backgroundColor: { default: 'default' }
  },
  content: 'none' as const
}

/** The markdown form: `[[target]]`, or `[[target|alias]]` when they differ. */
export function wikiLinkToText(target: string, alias: string): string {
  return alias && alias !== target ? `[[${target}|${alias}]]` : `[[${target}]]`
}

/**
 * Outer-to-inner in the order BlockNote nests its OWN marks on a styled text
 * run — measured, not assumed: a run styled `{bold, italic, strike, code}`
 * serializes to `<strong><em><s><code>…`, and `{bold, underline}` to
 * `<strong><u>…`. Matching that order is what makes a marked link serialize
 * byte-identically to the marked `[[A]]` text it was promoted from.
 *
 * `underline` is in the list for the editor chip only: rehype-remark drops
 * `<u>` on the way to markdown, so underline reaches the vault the same way an
 * underlined text run does — through the `<span style="text-decoration:…">`
 * masking in @memry/shared/inline-colors. Colours travel that same road, which
 * is why no colour is emitted here.
 */
const MARK_TAGS: ReadonlyArray<readonly [keyof WikiLinkMarkProps, string]> = [
  ['bold', 'strong'],
  ['italic', 'em'],
  ['underline', 'u'],
  ['strike', 's'],
  ['code', 'code']
]

/**
 * `text` nested inside the mark elements `props` carries. With no marks set
 * this is a bare text node, so an unmarked link's DOM — and therefore its
 * bytes — stay exactly what they are today.
 */
function renderMarkedText(text: string, props: Partial<WikiLinkMarkProps>): Node {
  let node: Node = document.createTextNode(text)
  for (let i = MARK_TAGS.length - 1; i >= 0; i--) {
    const [prop, tag] = MARK_TAGS[i]
    if (props[prop] !== true) continue
    const el = document.createElement(tag)
    el.appendChild(node)
    node = el
  }
  return node
}

type WikiLinkProps = { target: string; alias: string } & Partial<WikiLinkMarkProps>

/** The node's on-disk form. Identical in both processes — this is the contract. */
const wikiLinkToExternalHTML = (inlineContent: { props: WikiLinkProps }): { dom: HTMLElement } => {
  const dom = document.createElement('span')
  dom.appendChild(
    renderMarkedText(
      wikiLinkToText(inlineContent.props.target || '', inlineContent.props.alias || ''),
      inlineContent.props
    )
  )
  return { dom }
}

export const WikiLink = createInlineContentSpec(wikiLinkConfig, {
  render: (inlineContent) => {
    const props = inlineContent.props as WikiLinkProps
    const dom = document.createElement('span')
    dom.className = 'wiki-link'
    dom.setAttribute('data-wiki-link', '')
    dom.setAttribute('data-target', props.target || '')
    dom.setAttribute('data-alias', props.alias || '')
    dom.setAttribute('title', props.target || '')
    dom.setAttribute('contenteditable', 'false')
    // BlockNote's own stylesheet keys colours off these two attributes
    // (`[data-text-color=red]`), so the chip picks up the same palette value
    // the surrounding text does. Background colour lands; text colour is
    // currently outranked by `.wiki-link { color: … !important }` in base.css,
    // which is a stylesheet question, not a data one — the prop still has to be
    // carried or the colour is deleted from the vault file.
    if (props.textColor && props.textColor !== 'default') {
      dom.setAttribute('data-text-color', props.textColor)
    }
    if (props.backgroundColor && props.backgroundColor !== 'default') {
      dom.setAttribute('data-background-color', props.backgroundColor)
    }
    dom.appendChild(renderMarkedText(props.alias || props.target || '', props))

    return { dom }
  },
  parse: (element) => {
    if (element.hasAttribute('data-wiki-link') || element.hasAttribute('data-target')) {
      const target = element.getAttribute('data-target')?.trim() || ''
      const alias = element.getAttribute('data-alias')?.trim() || ''
      if (target) {
        return { target, alias }
      }
    }

    const parsed = parseWikiLinkText(element.textContent ?? '')
    if (!parsed) return undefined
    return { target: parsed.target, alias: parsed.alias }
  },
  toExternalHTML: wikiLinkToExternalHTML
})

/**
 * The same node for the main process — same type, same props, same on-disk
 * form — but with no `parse` rule.
 *
 * The rule above is an editor paste convenience: it promotes ANY element whose
 * whole text reads `[[X]]` into an inline node. In a markdown importer that is
 * structural damage — a `- [[A]]` list item, a `> [[A]]` quote and a `| [[A]] |`
 * table cell each parse as one such element, and the block around the link is
 * lost. Main only ever needs to READ these nodes out of the shared Y.Doc and
 * write them back, so it takes the node without the heuristic and keeps
 * markdown parsing byte-for-byte what it is today.
 *
 * `render` emits the same text as `toExternalHTML` rather than throwing:
 * BlockNote serializes inline content inside a TABLE through `render`, so a
 * throwing render made `yDocToMarkdown` return null for any note with a wiki
 * link in a table — that note then stopped writing back entirely. The marks
 * ride along in both, or a link in a table cell would lose them.
 */
export const WikiLinkSerializationOnly: InlineContentSpec<typeof wikiLinkConfig> =
  createInlineContentSpec(wikiLinkConfig, {
    render: wikiLinkToExternalHTML,
    toExternalHTML: wikiLinkToExternalHTML
  })
