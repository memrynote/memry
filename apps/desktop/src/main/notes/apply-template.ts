/**
 * Apply a template to an existing note: replace the body, optionally merge
 * the template's tags/properties (non-destructive), and update any open editor.
 *
 * @module notes/apply-template
 */

import { applyTemplate, getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { updateNoteCommand } from './domain'
import { replaceNoteBodyInCrdt, replaceNoteTagsInCrdt } from '../sync/crdt-feed'
import { NoteError, NoteErrorCode, VaultError, VaultErrorCode } from '../lib/errors'
import type { Template } from '@memry/contracts/templates-api'

/**
 * Build the NoteUpdateInput for applying a template to a note.
 * - `full`: union tags, merge properties (existing values win on conflict).
 * - `body`: content only; tags/properties left undefined so updateNote keeps them.
 */
export function buildTemplateApplyUpdate(
  note: Note,
  template: Template,
  mode: 'full' | 'body'
): NoteUpdateInput {
  const applied = applyTemplate(template, note.title)
  const update: NoteUpdateInput = { id: note.id, content: applied.content }

  if (mode === 'full') {
    update.tags = [...new Set([...note.tags, ...applied.tags])]
    update.properties = { ...applied.properties, ...note.properties }
  }

  return update
}

export async function applyTemplateToNote(input: {
  noteId: string
  templateId: string
  mode: 'full' | 'body'
}): Promise<Note> {
  const note = await getNoteById(input.noteId)
  if (!note) {
    throw new NoteError(`Note not found: ${input.noteId}`, NoteErrorCode.NOT_FOUND, input.noteId)
  }

  const template = await getTemplate(input.templateId)
  if (!template) {
    throw new VaultError(`Template not found: ${input.templateId}`, VaultErrorCode.NOT_FOUND)
  }

  const update = buildTemplateApplyUpdate(note, template, input.mode)
  const updated = await updateNoteCommand(update)

  // Update any open editor's Y.Doc so the replacement shows live.
  await replaceNoteBodyInCrdt(input.noteId, update.content ?? '')

  if (input.mode === 'full' && update.tags) {
    replaceNoteTagsInCrdt(input.noteId, update.tags)
  }

  return updated
}
