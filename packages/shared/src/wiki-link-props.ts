/**
 * The props of a `wikiLink` inline node that are not its target and alias.
 *
 * They live in `@memry/shared` because the sidecar marker readers in
 * `block-markers.ts` have to build and read the node, and `@memry/editor-schema`
 * (which owns the node's spec) depends on this package, not the other way round.
 */

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

export type WikiLinkSize = 'none' | 'small' | 'medium'

/**
 * How a wiki link that sits alone on its line is drawn. The default is the
 * inline chip; anything else is a card, and is stored on disk in a
 * `<!-- link-card:{…} -->` sidecar line (see `link-card-marker.ts`).
 */
export interface WikiLinkDisplayProps {
  size: WikiLinkSize
  cover: boolean
  preview: boolean
}

export const DEFAULT_WIKI_LINK_DISPLAY: Readonly<WikiLinkDisplayProps> = {
  size: 'none',
  cover: false,
  preview: false
}

export function isWikiLinkSize(value: unknown): value is WikiLinkSize {
  return value === 'none' || value === 'small' || value === 'medium'
}

/**
 * The display props a node's `props` carry, with anything missing or outside its
 * enum read as the default — an older build's node has none of them.
 */
export function wikiLinkDisplayProps(props: Record<string, unknown>): WikiLinkDisplayProps {
  return {
    size: isWikiLinkSize(props.size) ? props.size : DEFAULT_WIKI_LINK_DISPLAY.size,
    cover: props.cover === true,
    preview: props.preview === true
  }
}
