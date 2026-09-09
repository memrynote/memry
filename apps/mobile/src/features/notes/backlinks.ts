import { createLogger } from '@/lib/logger'
import type { VaultDb } from '@/db/index'

/**
 * Which notes link here, read at query time (issue #2092).
 *
 * Mobile has no link index table and no FTS, so this scans the markdown it
 * already holds. An index would not make the answer more complete — mobile only
 * stores bodies it has pulled either way — so the partiality is surfaced as
 * `missingBodies` rather than hidden behind a table that would still be
 * missing the same rows.
 */

const log = createLogger('Backlinks')

const SNIPPET_RADIUS = 75

export interface BacklinkMention {
  snippet: string
  linkStart: number
  linkEnd: number
  line: number
}

export interface Backlink {
  sourceId: string
  sourceTitle: string
  folderPath: string
  updatedAt: number
  mentions: BacklinkMention[]
}

export interface BacklinksResult {
  backlinks: Backlink[]
  totalReferences: number
  missingBodies: number
}

const EMPTY_RESULT: BacklinksResult = { backlinks: [], totalReferences: 0, missingBodies: 0 }

/**
 * `[[Title]]`, `[[Title#Heading]]`, `[[Title|Alias]]` and both halves together.
 * The title is matched whole, so `[[Title Other]]` is a different note.
 */
export function wikiLinkPattern(title: string): RegExp {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\[\\[${escaped}(?:#[^\\]|]*)?(?:\\|[^\\]]*)?\\]\\]`, 'gi')
}

/** Every mention of `title` in one markdown body, with its surrounding text. */
export function extractMentions(markdown: string, title: string): BacklinkMention[] {
  if (title.length === 0) return []
  const mentions: BacklinkMention[] = []
  for (const match of markdown.matchAll(wikiLinkPattern(title))) {
    const index = match.index ?? 0
    const text = match[0]
    const start = Math.max(0, index - SNIPPET_RADIUS)
    const end = Math.min(markdown.length, index + text.length + SNIPPET_RADIUS)

    const leading = start > 0 ? '...' : ''
    const trailing = end < markdown.length ? '...' : ''
    const raw = leading + markdown.slice(start, end) + trailing
    const collapsed = raw.replace(/\n+/g, ' ')
    // `trim()` only ever removes leading whitespace before the match, so the
    // offset shifts by exactly what the front lost.
    const snippet = collapsed.trim()
    const trimmedFront = collapsed.length - collapsed.trimStart().length

    const linkStart = index - start + leading.length - trimmedFront
    mentions.push({
      snippet,
      linkStart,
      linkEnd: linkStart + text.length,
      line: countLines(markdown, index)
    })
  }
  return mentions
}

function countLines(markdown: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i++) if (markdown[i] === '\n') line++
  return line
}

interface SourceRow {
  id: string
  payload: string | null
  updated_at: number
  markdown: string
}

function payloadOf(payload: string | null): { title: string; folderPath: string } | null {
  if (!payload) return null
  try {
    const parsed = JSON.parse(payload) as { title?: string; folderPath?: string | null }
    if (!parsed.title) return null
    return { title: parsed.title, folderPath: parsed.folderPath ?? '' }
  } catch {
    return null
  }
}

export async function readBacklinks(db: VaultDb, noteId: string): Promise<BacklinksResult> {
  try {
    const target = await db.getFirstAsync<{ payload: string | null }>(
      'SELECT payload FROM sync_items WHERE id = ?',
      [noteId]
    )
    const title = payloadOf(target?.payload ?? null)?.title
    if (!title) return EMPTY_RESULT

    const rows = await db.getAllAsync<SourceRow>(
      `SELECT s.id, s.payload, s.updated_at, b.markdown
         FROM note_bodies b
         JOIN sync_items s ON s.id = b.item_id
        WHERE s.type IN ('note', 'journal')
          AND s.deleted_at IS NULL
          AND s.id != ?
          AND b.markdown LIKE '%[[%'`,
      [noteId]
    )

    const backlinks: Backlink[] = []
    let totalReferences = 0
    for (const row of rows) {
      const source = payloadOf(row.payload)
      if (!source) continue
      const mentions = extractMentions(row.markdown, title)
      if (mentions.length === 0) continue
      totalReferences += mentions.length
      backlinks.push({
        sourceId: row.id,
        sourceTitle: source.title,
        folderPath: source.folderPath,
        updatedAt: row.updated_at,
        mentions
      })
    }
    backlinks.sort(
      (a, b) => b.updatedAt - a.updatedAt || a.sourceTitle.localeCompare(b.sourceTitle)
    )

    const missing = await db.getFirstAsync<{ count: number }>(
      `SELECT count(*) AS count FROM sync_items s
        WHERE s.type IN ('note', 'journal')
          AND s.deleted_at IS NULL
          AND s.id != ?
          AND NOT EXISTS (SELECT 1 FROM note_bodies b WHERE b.item_id = s.id)`,
      [noteId]
    )

    return { backlinks, totalReferences, missingBodies: missing?.count ?? 0 }
  } catch (error) {
    log.error('Reading backlinks failed', { noteId, error: String(error) })
    return EMPTY_RESULT
  }
}
