import { foldTag } from './tag-fold.ts'
import { wikiPathStem } from './wiki-target.ts'

export type NameKey = string & { readonly __brand: 'NameKey' }

export const MAX_NOTE_ALIASES = 32
export const MAX_NOTE_ALIAS_LENGTH = 200

/**
 * NFC, every run of Unicode White_Space collapsed to one space, trimmed, then
 * folded with `foldTag` (locale-free, so `İ` is `i` and final sigma is `σ`).
 * `\p{White_Space}` rather than `\s`, because Rust's `char::is_whitespace` is
 * that property and `\s` adds U+FEFF. Empty after trimming is `null`.
 */
export function nameKey(raw: string): NameKey | null {
  const spaced = raw.normalize('NFC').replace(/\p{White_Space}+/gu, ' ')
  const trimmed = spaced.replace(/^ /, '').replace(/ $/, '')
  return trimmed === '' ? null : (foldTag(trimmed) as NameKey)
}

/**
 * The alias list as frontmatter stores it: each spelling trimmed, empties and
 * over-long entries dropped, deduped by key with the first spelling kept, any
 * alias equal to the title dropped, at most `MAX_NOTE_ALIASES`. Order is kept.
 */
export function normalizeAliases(title: string, aliases: readonly string[]): string[] {
  const seen = new Set<NameKey | null>([nameKey(title)])
  const out: string[] = []
  for (const raw of aliases) {
    const spelling = raw.trim()
    const key = nameKey(spelling)
    if (key === null || spelling.length > MAX_NOTE_ALIAS_LENGTH || seen.has(key)) continue
    seen.add(key)
    out.push(spelling)
    if (out.length === MAX_NOTE_ALIASES) break
  }
  return out
}

export interface AliasDelta {
  readonly add: readonly string[]
  readonly remove: readonly string[]
}

/**
 * `current` with `remove` taken out (by key) and `add` appended. Adding a
 * present name or removing an absent one changes nothing, so two disjoint
 * edits applied in either order land the same list.
 */
export function applyAliasDelta(
  title: string,
  current: readonly string[],
  delta: AliasDelta
): string[] {
  const removed = new Set(delta.remove.map(nameKey))
  const kept = current.filter((alias) => !removed.has(nameKey(alias)))
  return normalizeAliases(title, [...kept, ...delta.add])
}

export interface WikiNameCandidate {
  readonly noteId: string
  readonly path: string
  readonly title: string
  readonly aliases: readonly string[]
}

export type WikiMatchKind = 'path' | 'title' | 'alias'

export interface WikiMatch {
  readonly noteId: string
  readonly path: string
  readonly matchedBy: WikiMatchKind
}

function lowestId<T extends WikiNameCandidate>(notes: readonly T[]): T | undefined {
  let best: T | undefined
  for (const note of notes) if (best === undefined || note.noteId < best.noteId) best = note
  return best
}

/**
 * The note a wiki-link note half names, or `null`. Tiers, first hit wins:
 * 1. a half holding `/` matches a vault path (`Folder/Note`, with or without
 *    `.md`), case folded;
 * 2. a title spelled exactly as written;
 * 3. a title with the same `nameKey`;
 * 4. an alias with the same `nameKey`.
 * A title always beats an alias. Two notes in one tier: the lowest `noteId`
 * (UTF-16 code unit order, which equals byte order for the ASCII ids notes use).
 */
export function pickWikiTarget(
  query: string,
  notes: readonly WikiNameCandidate[]
): WikiMatch | null {
  const stem = wikiPathStem(query)
  if (stem !== null) {
    const forms = new Set([foldTag(stem), foldTag(`${stem}.md`)])
    const byPath = lowestId(notes.filter((note) => forms.has(foldTag(note.path))))
    if (byPath) return { noteId: byPath.noteId, path: byPath.path, matchedBy: 'path' }
  }
  const key = nameKey(query)
  if (key === null) return null
  const written = query.trim()
  const byTitle =
    lowestId(notes.filter((note) => note.title === written)) ??
    lowestId(notes.filter((note) => nameKey(note.title) === key))
  if (byTitle) return { noteId: byTitle.noteId, path: byTitle.path, matchedBy: 'title' }
  const byAlias = lowestId(notes.filter((note) => note.aliases.some((a) => nameKey(a) === key)))
  return byAlias ? { noteId: byAlias.noteId, path: byAlias.path, matchedBy: 'alias' } : null
}
