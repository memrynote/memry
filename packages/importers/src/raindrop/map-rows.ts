import type { InboxItemPlan, RaindropImportPlan, RaindropRow, ImportWarning } from './types'
import { IMPORT_MESSAGE_CODES } from '../messages'

const UNSORTED = 'unsorted'
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/

/** Row tags + collection-as-tag; drops "Unsorted", trims, dedupes case-insensitively. */
function resolveTags(row: RaindropRow): string[] {
  const folder = row.folder.trim()
  const fromFolder = folder && folder.toLowerCase() !== UNSORTED ? [folder] : []
  const byKey = new Map<string, string>()
  for (const raw of [...row.tags, ...fromFolder]) {
    const tag = raw.trim()
    if (!tag) continue
    const key = tag.toLowerCase()
    if (!byKey.has(key)) byKey.set(key, tag)
  }
  return [...byKey.values()]
}

/** note + excerpt joined; null when both are empty. */
function resolveContent(row: RaindropRow): string | null {
  const parts = [row.note, row.excerpt].map((p) => p.trim()).filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Keep a valid ISO timestamp; otherwise fall back to the import time. */
function resolveCreatedAt(raw: string, now: string): string {
  const v = raw.trim()
  return ISO_DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : now
}

/** Map parsed Raindrop rows into inbox-item plans. Rows without a URL are skipped. */
export function mapRows(rows: RaindropRow[], opts: { now: string }): RaindropImportPlan {
  const items: InboxItemPlan[] = []
  const warnings: ImportWarning[] = []
  let skipped = 0

  rows.forEach((row, i) => {
    const url = row.url.trim()
    if (!url) {
      skipped++
      warnings.push({
        code: IMPORT_MESSAGE_CODES.raindropRowNoUrl,
        message: `Row ${i + 1} skipped: no URL`,
        params: { row: i + 1 },
        row: i + 1
      })
      return
    }
    items.push({
      title: row.title.trim() || url,
      content: resolveContent(row),
      sourceUrl: url,
      createdAt: resolveCreatedAt(row.created, opts.now),
      tags: resolveTags(row),
      metadata: {
        url,
        excerpt: row.excerpt.trim(),
        // Preserve the user's own annotation: the background article-extract job
        // overwrites `content` with the full page, but merges (keeps) metadata.
        note: row.note.trim(),
        folder: row.folder.trim(),
        favorite: row.favorite,
        heroImage: row.cover.trim(),
        highlights: row.highlights.trim()
      }
    })
  })

  return {
    items,
    stats: {
      bookmarks: items.length,
      withTags: items.filter((it) => it.tags.length > 0).length,
      skipped
    },
    sampleTitles: items.slice(0, 5).map((it) => it.title),
    warnings
  }
}
