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
