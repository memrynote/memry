import type * as Y from 'yjs'
import type {
  PortalGetUsageInput,
  PortalGetUsageResult,
  PortalSearchInput,
  PortalSearchResult,
  PortalSearchResultItem,
  PortalStampAnchorResult
} from '@memry/contracts/portals-api'
import { extractAnchor, makeAnchor, stripAnchor } from '@memry/shared/portal-block'
import {
  findNotesByTag,
  getLinkUsage,
  getNoteCacheById,
  getPortalUsage as queryPortalUsage
} from '@main/database/queries/notes'
import { getDatabase, getIndexDatabase } from '../database'
import { createLogger } from '../lib/logger'
import { searchQueries } from '../search/store'
import { getCrdtProvider } from '../sync/crdt-provider'
import { scheduleWriteback, writebackNow } from '../sync/crdt-writeback'
import { isNoteLocked } from '../vault-locks/registry'
import { listDocBlocks, stampAnchorInDoc } from './doc-blocks'

const log = createLogger('Portals')

/** Notes a search portal opens at most. Each one costs a Y.Doc load. */
export const PORTAL_SEARCH_CANDIDATE_CAP = 40

/** A tag-only search shows a note's first blocks, so one note cannot fill the list. */
const TAG_ONLY_BLOCKS_PER_NOTE = 5

const ANCHOR_ATTEMPTS = 20

export function getPortalUsage(input: PortalGetUsageInput): PortalGetUsageResult {
  const db = getIndexDatabase()
  const portals = queryPortalUsage(db, input.noteId, input.anchor).map((row) => ({
    noteId: row.hostNoteId,
    title: row.title,
    path: row.path,
    count: row.count,
    kind: 'portal' as const,
    ordinal: row.ordinal
  }))
  const links = getLinkUsage(db, input.noteId, input.anchor).map((row) => ({
    noteId: row.sourceNoteId,
    title: row.title,
    path: row.path,
    count: 1,
    kind: 'link' as const
  }))
  return { hosts: [...portals, ...links] }
}

/**
 * Run `read` against the note's Y.Doc. A doc a window already holds is used
 * as is. Otherwise main opens it for the call and closes it after, so the
 * edit and the file write-back both happen before the doc goes away.
 */
async function withDoc<T>(
  noteId: string,
  read: (doc: Y.Doc, openedHere: boolean) => Promise<T> | T
): Promise<T> {
  const provider = getCrdtProvider()
  const live = provider.getDoc(noteId)
  if (live) return read(live, false)
  const release = provider.holdDoc(noteId)
  try {
    return await read(await provider.open(noteId), true)
  } finally {
    await release()
  }
}

/** A fresh anchor not already in the note. */
function freshAnchor(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < ANCHOR_ATTEMPTS; attempt += 1) {
    const anchor = makeAnchor()
    if (!taken.has(anchor)) return anchor
  }
  // Six characters of base 36 leave 2 billion anchors; running out of 20 tries
  // means the random source is broken, not that the note is full.
  throw new Error('Could not find an unused anchor')
}

export async function stampAnchor(
  noteId: string,
  blockId: string
): Promise<PortalStampAnchorResult> {
  const note = getNoteCacheById(getIndexDatabase(), noteId)
  if (note?.fileType !== 'markdown') return { success: false, reason: 'missing-note' }
  if (isNoteLocked(noteId, note.path)) return { success: false, reason: 'locked' }

  return withDoc(noteId, async (doc, openedHere) => {
    const outcome = stampAnchorInDoc(doc, blockId, freshAnchor)
    if (outcome.kind === 'missing-block')
      return { success: false, reason: 'missing-block' as const }
    if (outcome.kind === 'stamped') {
      // An open doc writes back on its debounce. One opened here is closed
      // right after, so write it now or the file never learns the anchor.
      if (openedHere) await writebackNow(noteId, doc)
      else scheduleWriteback(noteId, doc, 'local')
    }
    return { success: true, anchor: outcome.anchor }
  })
}

function candidateNoteIds(input: PortalSearchInput): string[] {
  const indexDb = getIndexDatabase()
  if (input.text !== undefined) {
    const response = searchQueries.searchAll(indexDb, getDatabase(), {
      text: input.text,
      types: ['note'],
      tags: input.tag ? [input.tag] : [],
      dateRange: null,
      projectId: null,
      folderPath: null,
      limit: PORTAL_SEARCH_CANDIDATE_CAP,
      offset: 0,
      noteFileTypes: ['markdown']
    })
    return response.groups.flatMap((group) => group.results.map((result) => result.id))
  }
  return findNotesByTag(indexDb, input.tag ?? '')
    .filter((note) => note.fileType === 'markdown')
    .map((note) => note.id)
}

/**
 * Blocks matching a search portal's query. Note-level search (the FTS index,
 * or the tag index) picks at most `PORTAL_SEARCH_CANDIDATE_CAP` notes, then
 * each one's blocks are read from its Y.Doc, since a block id exists only
 * there. Text matches when every word is in the block, case-insensitively.
 */
export async function searchPortalBlocks(input: PortalSearchInput): Promise<PortalSearchResult> {
  const indexDb = getIndexDatabase()
  const terms = (input.text ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const candidates = [...new Set(candidateNoteIds(input))]
  let truncated = candidates.length > PORTAL_SEARCH_CANDIDATE_CAP
  const results: PortalSearchResultItem[] = []

  for (const noteId of candidates.slice(0, PORTAL_SEARCH_CANDIDATE_CAP)) {
    if (results.length > input.limit) break
    const note = getNoteCacheById(indexDb, noteId)
    if (note?.fileType !== 'markdown' || isNoteLocked(noteId, note.path)) continue

    try {
      const matches = await withDoc(noteId, (doc) => {
        const found: PortalSearchResultItem[] = []
        const docBlocks = listDocBlocks(doc)
        const textById = new Map(docBlocks.map((b) => [b.id, stripAnchor(b.text).trim()]))
        for (const block of docBlocks) {
          const text = stripAnchor(block.text).trim()
          if (text === '') continue
          if (terms.length > 0 && !terms.every((term) => text.toLowerCase().includes(term)))
            continue
          found.push({
            noteId,
            title: note.title,
            path: note.path,
            blockId: block.id,
            anchor: extractAnchor(block.text),
            text,
            parentText: (block.parentId && textById.get(block.parentId)) || null
          })
          if (terms.length === 0 && found.length === TAG_ONLY_BLOCKS_PER_NOTE) break
        }
        return found
      })
      results.push(...matches)
    } catch (err) {
      log.warn('Skipped a note whose blocks could not be read', { noteId, err })
    }
  }

  if (results.length > input.limit) truncated = true
  return { results: results.slice(0, input.limit), truncated }
}
