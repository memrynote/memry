/**
 * Template policy for a header tag added to a note: the first added tag whose
 * resolved schema names a template fills an empty body when the tag autofills,
 * and is offered otherwise. An applied body can be undone while it is untouched.
 *
 * @module notes/tag-template
 */

import { createHash, randomUUID } from 'crypto'
import type { NoteTagTemplateOutcome } from '@memry/contracts/notes-api'
import { getDatabase, getIndexDatabase } from '../database'
import { getNoteCacheById } from '@main/database/queries/notes'
import { getCrdtProvider } from '../sync/crdt-provider'
import { loadBlockNoteConverter } from '../sync/blocknote-converter-loader'
import { serializeNoteBody } from '../sync/writing-markdown'
import { loadResolvedTags } from '../tags/schema/read'
import { getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { createLogger } from '../lib/logger'
import { buildTemplateApplyUpdate } from './apply-template'

const log = createLogger('TagTemplate')

/** The note write path without this policy, so an applied body never re-enters it. */
type WriteNote = (input: NoteUpdateInput) => Promise<Note>

/** `${noteId}\0${token}` → sha256 of the body as read right after the apply. */
const appliedBodies = new Map<string, string>()

const undoKey = (noteId: string, token: string): string => `${noteId}\0${token}`
const hashBody = (body: string): string => createHash('sha256').update(body).digest('hex')

/** The body the user sees: the open doc's when an editor holds it, else the file's. */
async function readBody(note: Note): Promise<string | null> {
  const doc = getCrdtProvider().getDoc(note.id)
  if (!doc) return note.content
  const body = await serializeNoteBody(doc, { notePath: note.path }, await loadBlockNoteConverter())
  return body?.markdown ?? null
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
  const body = await readBody(note)
  if (body === null || body.trim() !== '') return offered

  const applied = await write(buildTemplateApplyUpdate(note, template, 'body'))
  const after = await readBody(applied)
  if (after === null) return { note: applied }
  const undoToken = randomUUID()
  appliedBodies.set(undoKey(note.id, undoToken), hashBody(after))
  return { note: applied, tagTemplate: { kind: 'applied', tag: hit.tag, undoToken } }
}

/** Empties the body again, only while it still holds exactly what the tag applied. */
export async function undoTagTemplate(
  input: { noteId: string; undoToken: string },
  write: WriteNote
): Promise<{ status: 'restored' | 'stale' }> {
  const key = undoKey(input.noteId, input.undoToken)
  const expected = appliedBodies.get(key)
  if (expected === undefined) return { status: 'stale' }
  appliedBodies.delete(key)

  const note = await getNoteById(input.noteId)
  const body = note ? await readBody(note) : null
  if (body === null || hashBody(body) !== expected) return { status: 'stale' }

  await write({ id: input.noteId, content: '' })
  return { status: 'restored' }
}
