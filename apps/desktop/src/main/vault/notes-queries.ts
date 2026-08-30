/**
 * Cross-note query operations: list, tag roll-up, link/backlink resolution.
 * Pulled from notes-crud.ts during the Phase 3.1 split to keep that file
 * under the 800-line guardrail (.claude/plans/tech-debt-remediation.md).
 *
 * @module vault/notes-queries
 */

import { createSnippet } from './frontmatter'
import { safeRead } from './file-ops'
import {
  getNoteCacheById,
  listNotesFromCache,
  countNotes,
  getTagsForNotes,
  getPropertiesForNotes,
  getOutgoingLinks,
  getIncomingReferences,
  type NoteTreeCacheRow
} from '@main/database/queries/notes'
import type { NoteCache } from '@memry/db-schema/schema/notes-cache'
import { getAllTagsWithCounts } from '@main/database/queries/tags'
import { getDatabase, getIndexDatabase } from '../database'
import { toAbsolutePath } from './notes-io'
import type {
  Note,
  NoteListItem,
  NoteListOptions,
  NoteListResponse,
  NoteLink,
  Backlink,
  NoteLinksResponse
} from './notes-crud'

// ============================================================================
// List
// ============================================================================

/**
 * A row `listNotes` can build a `NoteListItem` from: the narrow tree projection
 * plus the three columns only the full shape reads. A `NoteCache` satisfies it.
 */
type ListedNoteRow = NoteTreeCacheRow &
  Partial<Pick<NoteCache, 'snippet' | 'mimeType' | 'fileSize'>>

export function listNotes(options: NoteListOptions = {}): NoteListResponse {
  const db = getIndexDatabase()
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0

  // The sidebar tree renders path/title/modified/tags/emoji/localOnly/fileType
  // and nothing else, but a whole-vault fetch of the full shape still ships a
  // ~200-char snippet plus the mime/size pair for every note in the vault —
  // over IPC, and again on every list invalidation. 'tree' builds only what the
  // sidebar reads; the fields it skips are all optional on NoteListItem, so a
  // 'tree' row stays a valid NoteListItem for any other consumer. The same
  // choice is pushed down into the SQL projection so SQLite never reads the
  // dropped columns in the first place.
  const treeShape = options.fields === 'tree'

  const cached: ListedNoteRow[] = treeShape
    ? listNotesFromCache(db, { ...options, limit: limit + 1, offset, shape: 'tree' })
    : listNotesFromCache(db, { ...options, limit: limit + 1, offset })

  const hasMore = cached.length > limit
  const notes = cached.slice(0, limit)

  const total = countNotes(db, options.folder)

  const noteIds = notes.map((n) => n.id)
  const tagsMap = getTagsForNotes(db, noteIds)

  const propertiesMap = options.includeProperties ? getPropertiesForNotes(db, noteIds) : null

  const noteItems: NoteListItem[] = notes.map((c) => ({
    id: c.id,
    path: c.path,
    title: c.title,
    created: new Date(c.createdAt),
    modified: new Date(c.modifiedAt),
    tags: tagsMap.get(c.id) ?? [],
    // Null, not zero: a row the ingest backfill has not reached yet has no
    // measurement, and a file with no words is a different thing.
    wordCount: c.wordCount ?? null,
    ...(treeShape ? {} : { snippet: c.snippet ?? undefined }),
    emoji: c.emoji,
    localOnly: c.localOnly ?? false,
    fileType: c.fileType ?? 'markdown',
    ...(treeShape ? {} : { mimeType: c.mimeType, fileSize: c.fileSize }),
    ...(propertiesMap && { properties: propertiesMap.get(c.id) ?? {} })
  }))

  return { notes: noteItems, total, hasMore }
}

export function noteToListItem(note: Note): NoteListItem {
  return {
    id: note.id,
    path: note.path,
    title: note.title,
    created: note.created,
    modified: note.modified,
    tags: note.tags,
    wordCount: note.wordCount,
    snippet: createSnippet(note.content),
    emoji: note.emoji
  }
}

// ============================================================================
// Tags & Links
// ============================================================================

// This endpoint (notes:get-tags) feeds the editor's `#` autocomplete and the
// tag pickers. It used to carry its own copy of the orphan-definition sweep,
// which deleted any zero-usage row unconditionally — so a tag created in the
// hub survived `tags:get-all` only until the first picker opened. Delegating
// keeps one sweep with one predicate. It also merges counts case-insensitively,
// which the old copy's exact-case maps did not.
export function getTagsWithCounts(): { tag: string; color: string; count: number }[] {
  const indexDb = getIndexDatabase()
  const dataDb = getDatabase()

  return getAllTagsWithCounts(indexDb, dataDb).map((tag) => ({
    tag: tag.name,
    color: tag.color ?? '',
    count: tag.count
  }))
}

interface LinkContext {
  snippet: string
  linkStart: number
  linkEnd: number
}

function extractAllLinkContexts(content: string, targetTitle: string): LinkContext[] {
  const escaped = targetTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`\\[\\[${escaped}(?:\\|[^\\]]+)?\\]\\]`, 'gi')
  const matches = [...content.matchAll(pattern)]
  if (matches.length === 0) return []

  const radius = 75

  return matches.map((match) => {
    const matchIndex = match.index ?? 0
    const matchText = match[0]
    const start = Math.max(0, matchIndex - radius)
    const end = Math.min(content.length, matchIndex + matchText.length + radius)

    let snippet = content.slice(start, end)
    const prefixOffset = start > 0 ? 3 : 0
    if (start > 0) snippet = '...' + snippet
    if (end < content.length) snippet = snippet + '...'

    snippet = snippet.replace(/\n+/g, ' ').trim()

    const linkStart = matchIndex - start + prefixOffset
    const linkEnd = linkStart + matchText.length

    return { snippet, linkStart, linkEnd }
  })
}

export async function getNoteLinks(id: string): Promise<NoteLinksResponse> {
  const db = getIndexDatabase()

  const outgoing = getOutgoingLinks(db, id)
  const outgoingLinks: NoteLink[] = outgoing.map((link) => ({
    sourceId: link.sourceId,
    targetId: link.targetId,
    targetTitle: link.targetTitle
  }))

  const incoming = getIncomingReferences(db, id)
  const targetCache = getNoteCacheById(db, id)
  const targetTitle = targetCache?.title ?? ''

  const backlinks: Backlink[] = await Promise.all(
    incoming.map(async (ref) => {
      const sourceCache = getNoteCacheById(db, ref.sourceNoteId)
      let contexts: Backlink['contexts'] = []

      // Contexts come from scanning the source for `[[target]]`, so they belong
      // to the wiki link only. A property-sourced entry (`ref.via` set) has no
      // text occurrence of its own — copying the wiki link's snippets onto it
      // would show the same excerpts twice under two labels, and inflate the
      // property card's mention count with matches it did not produce.
      if (!ref.via && sourceCache?.path && targetTitle) {
        const absolutePath = toAbsolutePath(sourceCache.path)
        const content = await safeRead(absolutePath)
        if (content) {
          contexts = extractAllLinkContexts(content, targetTitle)
        }
      }

      return {
        sourceId: ref.sourceNoteId,
        sourcePath: sourceCache?.path ?? '',
        sourceTitle: sourceCache?.title ?? '',
        contexts,
        via: ref.via
      }
    })
  )

  return { outgoing: outgoingLinks, incoming: backlinks }
}
