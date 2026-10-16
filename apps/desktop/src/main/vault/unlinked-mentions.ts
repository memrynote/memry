/**
 * Unlinked mentions (#3320): notes whose body spells a note's title or one of
 * its aliases as plain text, without linking to it, and the "Link" action that
 * turns one such mention into `[[Title|text]]`.
 *
 * Computed on demand, with no index of its own: the FTS index narrows the
 * vault to notes holding a name's words, and the exact whole-word match
 * (`@memry/shared/unlinked-mentions`) then runs over each candidate's file.
 * A source that already links to the note is a backlink and is left out.
 *
 * @module vault/unlinked-mentions
 */

import { sql } from 'drizzle-orm'
import type { UnlinkedMention } from '@memry/contracts/notes-api'
import { splitFrontmatterBlock } from '@memry/shared/frontmatter-split'
import { isBinaryFileType } from '@memry/shared/file-types'
import { findUnlinkedMentions, linkUnlinkedMention } from '@memry/shared/unlinked-mentions'
import {
  getAliasesForNotes,
  getIncomingReferences,
  getNoteCacheById
} from '@main/database/queries/notes'
import { getIndexDatabase, type IndexDb } from '../database'
import { readVaultFile } from '../lib/paths'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { assertNoteWritable } from '../vault-locks/registry'
import { getVaultRoot } from './notes-io'
import { landSourceRewrite } from './rename-link-rewrite'

const SNIPPET_RADIUS = 60

function targetNames(db: IndexDb, noteId: string): { title: string; names: string[] } | null {
  const target = getNoteCacheById(db, noteId)
  if (!target) return null
  return {
    title: target.title,
    names: [target.title, ...(getAliasesForNotes(db, [noteId]).get(noteId) ?? [])]
  }
}

/** Ids of notes whose body holds every word of at least one name. */
function candidateIds(db: IndexDb, names: readonly string[]): string[] {
  // A name with no letter or digit has no FTS token, so it can find nothing.
  const phrases = names
    .filter((name) => /[\p{L}\p{N}]/u.test(name))
    .map((name) => `"${name.trim().replaceAll('"', '""')}"`)
  if (phrases.length === 0) return []
  const query = `content : (${phrases.join(' OR ')})`
  return db
    .all<{ id: string }>(sql`SELECT id FROM fts_notes WHERE fts_notes MATCH ${query}`)
    .map((row) => row.id)
}

function snippetAround(body: string, start: number, end: number): UnlinkedMention['contexts'][0] {
  const from = Math.max(0, start - SNIPPET_RADIUS)
  const to = Math.min(body.length, end + SNIPPET_RADIUS)
  const lead = from > 0 ? '…' : ''
  const raw = body.slice(from, to)
  const snippet = `${lead}${raw}${to < body.length ? '…' : ''}`.replace(/\s/g, ' ')
  return { snippet, linkStart: lead.length + start - from, linkEnd: lead.length + end - from }
}

async function readBody(path: string): Promise<string | null> {
  const raw = await readVaultFile(getVaultRoot(), path)
  return raw === null ? null : splitFrontmatterBlock(raw).body
}

export async function getUnlinkedMentions(noteId: string): Promise<UnlinkedMention[]> {
  const db = getIndexDatabase()
  const target = targetNames(db, noteId)
  if (!target) return []
  const linked = new Set(getIncomingReferences(db, noteId).map((ref) => ref.sourceNoteId))

  const out: UnlinkedMention[] = []
  for (const sourceId of candidateIds(db, target.names)) {
    if (sourceId === noteId || linked.has(sourceId)) continue
    const source = getNoteCacheById(db, sourceId)
    if (!source || (source.fileType && isBinaryFileType(source.fileType))) continue
    const body = await readBody(source.path)
    if (body === null) continue
    const mentions = findUnlinkedMentions(body, target.names)
    if (mentions.length === 0) continue
    out.push({
      sourceId,
      sourcePath: source.path,
      sourceTitle: source.title,
      contexts: mentions.map((mention) => snippetAround(body, mention.start, mention.end))
    })
  }
  return out.sort((a, b) => a.sourceTitle.localeCompare(b.sourceTitle))
}

/**
 * Turn the source's `ordinal`-th mention of the target into a wiki link.
 * `false` when that mention is gone; a missing or locked note is an error.
 */
export async function linkUnlinkedMentionInSource(input: {
  sourceId: string
  targetId: string
  ordinal: number
}): Promise<boolean> {
  const db = getIndexDatabase()
  const target = targetNames(db, input.targetId)
  const source = getNoteCacheById(db, input.sourceId)
  if (!target || !source) {
    const missing = target ? input.sourceId : input.targetId
    throw new NoteError(`Note not found: ${missing}`, NoteErrorCode.NOT_FOUND, missing)
  }
  assertNoteWritable(source.id, source.path)
  const raw = await readVaultFile(getVaultRoot(), source.path)
  if (raw === null) return false
  const { block, body } = splitFrontmatterBlock(raw)
  const linked = linkUnlinkedMention(body, target.names, input.ordinal, target.title)
  if (linked === null) return false
  await landSourceRewrite(db, source, {
    path: source.path,
    title: source.title,
    content: (block ?? '') + linked
  })
  return true
}
