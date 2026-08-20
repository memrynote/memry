/**
 * Splitting a wiki-link target into its note and heading halves.
 *
 * `[[Note#Heading]]` is Obsidian's syntax for "that heading inside that note",
 * and a vault imported from Obsidian is full of them. Memry kept the whole
 * string as the link's `target` and looked it up as a note title, so the lookup
 * missed and the note page cheerfully created `Note#Heading.md` — a real file,
 * written into the vault and synced to every device (A15). The same missed
 * lookup is why those links have no hover preview and why the note they point
 * at never lists them as a backlink.
 *
 * Splitting is deliberately NOT the whole answer. `#` is legal in a filename,
 * so `Sprint #4` is a note somebody may really have, and a split-only reading
 * would turn its links into "heading `4` of note `Sprint`". Callers therefore
 * resolve SPLIT FIRST and fall back to the raw string — see `resolveWikiLink`.
 * That order is what lets `[[Note#Heading]]` reach `Note` while `[[Sprint #4]]`
 * still reaches `Sprint #4`, and it is also what makes the junk notes this bug
 * already created harmless: they are simply never consulted.
 *
 * Nothing here touches the on-disk form. `target` stays the raw string in the
 * document, in the vault file and in the shared Y.Doc; this is a reading of it,
 * not a rewrite of it.
 */

export interface WikiTargetParts {
  /** The note half. Empty when the link addresses the note it sits in. */
  note: string
  /** The heading half, or `null` when the target carries no `#` at all. */
  heading: string | null
}

/**
 * `Note#Heading` → `{ note: 'Note', heading: 'Heading' }`.
 *
 * `Note#H1#H2` addresses a heading nested under another one. Only the last
 * segment names something a text match can find, and the intermediate ones add
 * nothing, so the last one is the heading.
 */
export function splitWikiTarget(target: string): WikiTargetParts {
  const raw = target.trim()
  const hash = raw.indexOf('#')
  if (hash === -1) return { note: raw, heading: null }

  const segments = raw.slice(hash + 1).split('#')
  return {
    note: raw.slice(0, hash).trim(),
    heading: (segments[segments.length - 1] ?? '').trim()
  }
}

/**
 * Whether a heading half is really a block reference (`[[Note#^block-id]]`).
 *
 * Block references need a persistent `^id` on every block, serialized to
 * markdown and carried through the CRDT — a feature Memry does not have. They
 * are recognised here only so the link still OPENS the note instead of being
 * mistaken for a heading nobody will ever find (and, before this, instead of
 * minting a file named after the block id).
 */
export function isBlockReference(heading: string): boolean {
  return heading.startsWith('^')
}

/**
 * The form two heading strings are compared in: trimmed and case-folded.
 *
 * A link carries a heading's TEXT, never its id or its level, so matching can
 * only ever be a text match — `## Notes` and `### notes` are the same target
 * and the first one in the document wins.
 */
export function normalizeHeading(heading: string): string {
  return heading.trim().toLowerCase()
}

/**
 * The text a wiki-link reads as once the brackets are gone.
 *
 * Six plain-text surfaces — search snippets, journal previews, note excerpts,
 * the home journal widget and HTML/PDF export — cannot render a chip, so they
 * strip the brackets and keep what is inside. Keeping the whole target leaks
 * the heading half (`Note#Heading`), and the alias, when there is one, is the
 * label the user chose and the only thing they expect to read.
 *
 * The heading half goes because these callers have no note table to consult:
 * `resolveWikiLink`'s split-first-then-raw order needs a lookup, and a string
 * pass cannot do one. The cost is `[[Sprint #4]]`, a title that really carries
 * a `#`, reading as `Sprint` in a preview — cosmetic, and confined to text that
 * was never the link itself.
 */
export function wikiLinkLabel(target: string, alias?: string | null): string {
  const chosen = alias?.trim() ?? ''
  if (chosen) return chosen

  const { note, heading } = splitWikiTarget(target)
  // `[[#Heading]]` addresses the note it sits in, so the heading is the whole
  // of what it says; anything else would leave the sentence with a hole in it.
  return note || (heading ?? '')
}

/** Matches `[[target]]` and `[[target|alias]]`. */
const WIKI_LINK_RUN = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

/**
 * Replace every `[[…]]` run with its label, optionally wrapped by `render`.
 *
 * The one place all six strippers now agree. They used to each carry their own
 * pair of regexes, and two of them replaced with `'$2$1'` — which concatenates
 * rather than chooses, so `[[Sprint Notes|retro]]` came out `retroSprint Notes`.
 */
export function replaceWikiLinks(
  markdown: string,
  render: (label: string) => string = (label) => label
): string {
  return markdown.replace(WIKI_LINK_RUN, (_run, target: string, alias?: string) =>
    render(wikiLinkLabel(target, alias))
  )
}

/** A wiki-link target matched to a record, plus the heading to scroll to. */
export interface ResolvedWikiTarget<T> {
  match: T
  /**
   * The heading the link addresses, or `null` when there is nothing to scroll
   * to — no `#` in the target, a `#^block-id` we cannot find, or a match that
   * came from the raw string, where the `#` turned out to be part of the title.
   */
  heading: string | null
}

/**
 * Resolve a wiki-link target through a title lookup, split half first.
 *
 * The order is the whole point and it is load-bearing in both directions:
 * `[[Meeting#Decisions]]` must reach `Meeting`, and `[[Sprint #4]]` must still
 * reach the note somebody really named `Sprint #4`. `resolveByTitle` itself
 * stays heading-blind on purpose — its contract is "is there a note with this
 * title", and folding wiki grammar into it would make `Sprint #4` unfindable
 * by its own name. So the grammar lives here, one layer up, where every caller
 * outside the renderer (the CLI, the agent MCP surface) can share it.
 *
 * `lookup` is whatever "find a note with this title" means to the caller — a
 * data-DB row for the CLI, an index-DB row in the main process.
 */
export async function resolveWikiTarget<T>(
  target: string,
  lookup: (title: string) => T | null | undefined | Promise<T | null | undefined>
): Promise<ResolvedWikiTarget<T> | null> {
  const raw = target.trim()
  if (!raw) return null

  const { note, heading } = splitWikiTarget(raw)

  if (heading !== null) {
    // `[[#Heading]]` addresses the note it is written in. There is no title to
    // look up, and the caller — which knows which note that is — answers it.
    if (!note) return null

    const bySplit = await lookup(note)
    if (bySplit) return { match: bySplit, heading: headingAnchor(heading) }
  }

  const byRaw = await lookup(raw)
  return byRaw ? { match: byRaw, heading: null } : null
}

/** The heading half as something to scroll to, or `null` when it is not. */
function headingAnchor(heading: string): string | null {
  if (!heading || isBlockReference(heading)) return null
  return heading
}
