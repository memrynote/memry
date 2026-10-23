import { normalizeAliases } from '@memry/shared/note-names'

// Mirrors desktop's `extractAliases` (main/vault/frontmatter.ts): the `aliases`
// frontmatter list as the app reads it — scalars only, trimmed, deduped by name
// key, never equal to the title. The file is the source of truth: the index's
// `note_names` rows are projected by a running desktop and a CLI edit does not
// update them, so name lookups read this instead.
export function aliasesFromFrontmatter(
  frontmatter: Record<string, unknown>,
  title: string
): string[] {
  const raw = frontmatter.aliases
  const list = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]
  return normalizeAliases(
    title,
    list.map((entry: unknown) =>
      typeof entry === 'string' || typeof entry === 'number' ? String(entry) : ''
    )
  )
}
