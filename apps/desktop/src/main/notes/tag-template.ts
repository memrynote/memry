/**
 * Template policy for a header tag added to a note: the first added tag whose
 * resolved schema names a template fills an empty body when the tag autofills,
 * and is offered otherwise. An applied body can be undone while it is untouched.
 *
 * @module notes/tag-template
 */

import { createHash, randomUUID } from 'crypto'
import type * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import type { NoteTagTemplateOutcome } from '@memry/contracts/notes-api'
import { getDatabase, getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getCrdtProvider } from '../sync/crdt-provider'
import { loadBlockNoteConverter } from '../sync/blocknote-converter-loader'
import { serializeNoteBody } from '../sync/writing-markdown'
import { replaceDocBody } from '../sync/crdt-feed'
import { writebackNow } from '../sync/crdt-writeback'
import { loadResolvedTags } from '../tags/schema/read'
import { getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { createLogger } from '../lib/logger'
import { buildTemplateApplyUpdate } from './apply-template'

const log = createLogger('TagTemplate')

/** The note write path without this policy, so an applied body never re-enters it. */
type WriteNote = (input: NoteUpdateInput) => Promise<Note>

/**
 * noteId → its one live undo: the token and the sha256 of the body as read
 * right after the apply. A later apply on the note replaces it, and the oldest
 * entries go once the map holds MAX_UNDOS notes.
 */
const appliedBodies = new Map<string, { token: string; hash: string }>()
const MAX_UNDOS = 100

const hashBody = (body: string): string => createHash('sha256').update(body).digest('hex')

function rememberApplied(noteId: string, token: string, body: string): void {
  appliedBodies.delete(noteId)
  appliedBodies.set(noteId, { token, hash: hashBody(body) })
  for (const oldest of appliedBodies.keys()) {
    if (appliedBodies.size <= MAX_UNDOS) break
    appliedBodies.delete(oldest)
  }
}

async function serializeDocBody(doc: Y.Doc, notePath: string): Promise<string | null> {
  const body = await serializeNoteBody(doc, { notePath }, await loadBlockNoteConverter())
  return body?.markdown ?? null
}

/**
 * Replaces the body only while it still matches `accepts`. An open note is
 * checked and replaced in one doc transaction, so typing in between wins and
 * the write-back then writes the file. A closed note is written through the
 * note write path. Neither moves the body's `#tags` into or out of the header.
 */
async function replaceBodyIf(
  note: Note,
  markdown: string,
  accepts: (body: string) => boolean,
  write: WriteNote
): Promise<Note | null> {
  const doc = getCrdtProvider().getDoc(note.id)
  if (!doc) {
    if (!accepts(note.content)) return null
    return write({ id: note.id, content: markdown, ignoreInlineTags: true })
  }
  const seen = doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON()
  const body = await serializeDocBody(doc, note.path)
  if (body === null || !accepts(body)) return null
  if (!(await replaceDocBody(doc, note.id, markdown, undefined, seen))) return null
  await writebackNow(note.id, doc)
  return { ...((await getNoteById(note.id)) ?? note), content: markdown }
}

/** The added tags in the order the caller added them. */
function addedInOrder(requested: string[] | undefined, added: string[]): string[] {
  if (!requested) return added
  const wasAdded = new Set(added.map((tag) => tag.toLowerCase()))
  return requested.filter((tag) => wasAdded.has(tag.toLowerCase()))
}

/** The first tag (in the order given) whose resolved schema names a template. */
function firstTagTemplate(
  tags: readonly string[]
): { tag: string; templateId: string; autofill: boolean } | null {
  if (tags.length === 0) return null
  const resolved = loadResolvedTags(getDatabase())
  for (const tag of tags) {
    const template = resolved.get(tag.toLowerCase())?.template
    if (template) return { tag, templateId: template.id, autofill: template.autofill }
  }
  return null
}

export async function applyTagTemplateAfterAdd(
  note: Note,
  change: { requested: string[] | undefined; added: string[] },
  write: WriteNote
): Promise<{ note: Note; tagTemplate?: NoteTagTemplateOutcome }> {
  // Journals never take a template.
  if (getNoteCacheById(getIndexDatabase(), note.id)?.date) return { note }
  const hit = firstTagTemplate(addedInOrder(change.requested, change.added))
  if (!hit) return { note }

  const template = await getTemplate(hit.templateId)
  if (!template) {
    log.warn('Tag names a template that does not exist', {
      tag: hit.tag,
      templateId: hit.templateId
    })
    return { note }
  }

  const offered = { note, tagTemplate: { kind: 'offered' as const, tag: hit.tag } }
  if (!hit.autofill) return offered
  const markdown = buildTemplateApplyUpdate(note, template, 'body').content ?? ''
  const applied = await replaceBodyIf(note, markdown, (body) => body.trim() === '', write)
  if (!applied) return offered

  const doc = getCrdtProvider().getDoc(note.id)
  const after = doc ? await serializeDocBody(doc, note.path) : applied.content
  if (after === null) return { note: applied }
  const undoToken = randomUUID()
  rememberApplied(note.id, undoToken, after)
  return { note: applied, tagTemplate: { kind: 'applied', tag: hit.tag, undoToken } }
}

/** Empties the body again, only while it still holds exactly what the tag applied. */
export async function undoTagTemplate(
  input: { noteId: string; undoToken: string },
  write: WriteNote
): Promise<{ status: 'restored' | 'stale' }> {
  const applied = appliedBodies.get(input.noteId)
  if (applied?.token !== input.undoToken) return { status: 'stale' }
  appliedBodies.delete(input.noteId)

  const note = await getNoteById(input.noteId)
  const untouched = (body: string): boolean => hashBody(body) === applied.hash
  const restored = note ? await replaceBodyIf(note, '', untouched, write) : null
  return { status: restored ? 'restored' : 'stale' }
}
