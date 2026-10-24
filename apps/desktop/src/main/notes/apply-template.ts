/**
 * Apply a template to an existing note: replace the body, optionally merge
 * the template's tags/properties (non-destructive), and update any open editor.
 *
 * @module notes/apply-template
 */

import { getTemplate } from '../vault/templates'
import { getNoteById, type Note, type NoteUpdateInput } from '../vault/notes'
import { updateNoteCommand } from './domain'
import { buildTemplateApplyUpdate } from './template-update'
import { NoteError, NoteErrorCode, VaultError, VaultErrorCode } from '../lib/errors'
import { assertNoteWritable } from '../vault-locks/registry'
import { markAddedChecklistLinesPlain } from '../import/_shared/checklist-tasks'
import type { PlainChecklistsOption } from '@memry/contracts/plain-checklists'

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
  // Feeds the body and the header tags to the note's Y.Doc, so an open editor shows them live.
  return updateNoteCommand(update)
}
