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
  getAllTags,
  getAllTagDefinitions,
  getOrCreateTag,
  deleteTagDefinition,
  getPropertiesForNotes,
  getOutgoingLinks,
  getIncomingLinks
} from '@main/database/queries/notes'
import { getAllTaskTags } from '@main/database/queries/tasks'
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

export function listNotes(options: NoteListOptions = {}): NoteListResponse {
  const db = getIndexDatabase()
  const limit = options.limit ?? 100
  const offset = options.offset ?? 0

  const cached = listNotesFromCache(db, {
    ...options,
    limit: limit + 1,
    offset
  })

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
    wordCount: c.wordCount ?? 0,
    snippet: c.snippet ?? undefined,
    emoji: c.emoji,
    localOnly: c.localOnly ?? false,
    fileType: c.fileType ?? 'markdown',
    mimeType: c.mimeType,
    fileSize: c.fileSize,
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

export function getTagsWithCounts(): { tag: string; color: string; count: number }[] {
  const indexDb = getIndexDatabase()
  const dataDb = getDatabase()

  const definitions = getAllTagDefinitions(dataDb)
  const noteUsage = getAllTags(indexDb)
  const taskUsage = getAllTaskTags(dataDb)

  const noteCountMap = new Map(noteUsage.map((u) => [u.tag, u.count]))
  const taskCountMap = new Map(taskUsage.map((u) => [u.tag, u.count]))
  const defMap = new Map(definitions.map((d) => [d.name, d.color]))

  const results: { tag: string; color: string; count: number }[] = []

  for (const def of definitions) {
    const totalCount = (noteCountMap.get(def.name) ?? 0) + (taskCountMap.get(def.name) ?? 0)
    if (totalCount > 0) {
      results.push({ tag: def.name, color: def.color, count: totalCount })
    } else {
      deleteTagDefinition(dataDb, def.name)
    }
  }

  for (const usage of noteUsage) {
    if (!defMap.has(usage.tag)) {
      const { color } = getOrCreateTag(dataDb, usage.tag)
      defMap.set(usage.tag, color)
      const totalCount = usage.count + (taskCountMap.get(usage.tag) ?? 0)
      results.push({ tag: usage.tag, color, count: totalCount })
    }
  }

  for (const usage of taskUsage) {
    if (!defMap.has(usage.tag) && !noteCountMap.has(usage.tag)) {
      const { color } = getOrCreateTag(dataDb, usage.tag)
      results.push({ tag: usage.tag, color, count: usage.count })
    }
  }

  return results.sort((a, b) => b.count - a.count)
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

  const incoming = getIncomingLinks(db, id)
  const targetCache = getNoteCacheById(db, id)
  const targetTitle = targetCache?.title ?? ''

  const backlinks: Backlink[] = await Promise.all(
    incoming.map(async (link) => {
      const sourceCache = getNoteCacheById(db, link.sourceId)
      let contexts: Backlink['contexts'] = []

      if (sourceCache?.path && targetTitle) {
        const absolutePath = toAbsolutePath(sourceCache.path)
        const content = await safeRead(absolutePath)
        if (content) {
          contexts = extractAllLinkContexts(content, targetTitle)
        }
      }

      return {
        sourceId: link.sourceId,
        sourcePath: sourceCache?.path ?? '',
        sourceTitle: sourceCache?.title ?? '',
        contexts
      }
    })
  )

  return { outgoing: outgoingLinks, incoming: backlinks }
}
