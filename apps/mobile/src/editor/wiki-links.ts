import type { WikiCandidate } from '@memry/contracts/webview-bridge'
import type { VaultDb } from '../db/index'

/**
 * The RN half of wiki-links (T067 / FR-014).
 *
 * Both halves of a wiki link resolve against the note TITLE, not a path or an
 * id: that is what the on-disk `[[Target]]` form carries, and what desktop
 * resolves. The displayed text is the alias — a rule the shared spec already
 * owns — so nothing here touches presentation.
 */

/** `Title#Heading` — the heading half is resolved after the note opens. */
export interface WikiTarget {
  title: string
  heading: string | null
}

export function parseWikiTarget(target: string): WikiTarget {
  const hash = target.indexOf('#')
  if (hash === -1) return { title: target.trim(), heading: null }
  return {
    title: target.slice(0, hash).trim(),
    heading: target.slice(hash + 1).trim() || null
  }
}

interface NoteTitleRow {
  id: string
  payload: string | null
}

function titleOf(payload: string | null): { title: string; folderPath: string } | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as { title?: string; folderPath?: string | null }
    return { title: parsed.title ?? 'Untitled', folderPath: parsed.folderPath ?? '' }
  } catch {
    return null
  }
}

/**
 * Resolve a tapped link to a note id.
 *
 * Case-insensitive, like every other title match in Memry, and it prefers an
 * exact-case hit so two notes differing only in case still open the one the
 * link actually names.
 */
export async function resolveWikiTarget(db: VaultDb, target: string): Promise<string | null> {
  const { title } = parseWikiTarget(target)
  if (title.length === 0) return null

  const rows = await db.getAllAsync<NoteTitleRow>(
    `SELECT id, payload FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL AND payload_state = 'full'`
  )

  const wanted = title.toLowerCase()
  let caseInsensitive: string | null = null
  for (const row of rows) {
    const parsed = titleOf(row.payload)
    if (!parsed) continue
    if (parsed.title === title) return row.id
    if (caseInsensitive === null && parsed.title.toLowerCase() === wanted) caseInsensitive = row.id
  }
  return caseInsensitive
}

/** Autocomplete candidates for `[[query`. Prefix hits first, then substring. */
export async function queryWikiCandidates(
  db: VaultDb,
  query: string,
  limit = 8
): Promise<WikiCandidate[]> {
  const rows = await db.getAllAsync<NoteTitleRow>(
    `SELECT id, payload FROM sync_items
     WHERE type IN ('note', 'journal') AND deleted_at IS NULL AND payload_state = 'full'
     ORDER BY updated_at DESC`
  )

  const needle = query.trim().toLowerCase()
  const prefix: WikiCandidate[] = []
  const contains: WikiCandidate[] = []

  for (const row of rows) {
    const parsed = titleOf(row.payload)
    if (!parsed) continue
    const candidate: WikiCandidate = {
      id: row.id,
      title: parsed.title,
      ...(parsed.folderPath ? { folderPath: parsed.folderPath } : {})
    }
    const haystack = parsed.title.toLowerCase()
    // An empty query means "the notes I touched most recently", which is the
    // useful answer the moment `[[` is typed and nothing else is known yet.
    if (needle.length === 0 || haystack.startsWith(needle)) prefix.push(candidate)
    else if (haystack.includes(needle)) contains.push(candidate)
    if (prefix.length >= limit) break
  }

  return [...prefix, ...contains].slice(0, limit)
}
