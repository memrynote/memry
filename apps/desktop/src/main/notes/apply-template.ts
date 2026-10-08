/**
 * Apply a template to an existing note: replace the body, optionally merge
 * the template's tags/properties (non-destructive), and update any open editor.
 *
 * @module notes/apply-template
 */

import { applyTemplate, getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { updateNoteCommand } from './domain'
import { replaceNoteTagsInCrdt } from '../sync/crdt-feed'
import { NoteError, NoteErrorCode, VaultError, VaultErrorCode } from '../lib/errors'
import { assertNoteWritable } from '../vault-locks/registry'
import { markAddedChecklistLinesPlain } from '../import/_shared/checklist-tasks'
import type { Template } from '@memry/contracts/templates-api'
import type { PlainChecklistsOption } from '@memry/contracts/notes-api'

/**
 * Build the NoteUpdateInput for applying a template to a note.
 * - `full`: union tags, merge properties (existing values win on conflict), and
 *   adopt the template's icon only when the note has none of its own.
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
    if (!note.emoji && applied.icon) {
      update.emoji = applied.icon
    }
  }

  return update
}

export async function applyTemplateToNote(
  input: { noteId: string; templateId: string; mode: 'full' | 'body' } & PlainChecklistsOption
): Promise<Note> {
  const note = await getNoteById(input.noteId)
  if (!note) {
    throw new NoteError(`Note not found: ${input.noteId}`, NoteErrorCode.NOT_FOUND, input.noteId)
  }
  assertNoteWritable(note.id, note.path)

  const template = await getTemplate(input.templateId)
  if (!template) {
    throw new VaultError(`Template not found: ${input.templateId}`, VaultErrorCode.NOT_FOUND)
  }

  const update = buildTemplateApplyUpdate(note, template, input.mode)
  if (input.plainChecklists && update.content !== undefined) {
    update.content = markAddedChecklistLinesPlain(update.content, note.content)
  }
  // Feeds the body to the note's Y.Doc, so an open editor shows it live.
  const updated = await updateNoteCommand(update)

  if (input.mode === 'full' && update.tags) {
    replaceNoteTagsInCrdt(input.noteId, update.tags)
  }

  return updated
}
