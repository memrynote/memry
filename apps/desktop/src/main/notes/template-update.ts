import { applyTemplate } from '../vault/templates'
import type { Note, NoteUpdateInput } from '../vault/notes'
import type { Template } from '@memry/contracts/templates-api'

/**
 * Build the NoteUpdateInput for applying a template to a note.
 * - `full`: add the template's tags to the header, merge properties (existing
 *   values win on conflict), and adopt the template's icon only when the note
 *   has none of its own.
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
    if (applied.tags.length > 0) update.headerTags = { add: applied.tags }
    update.properties = { ...applied.properties, ...note.properties }
    if (!note.emoji && applied.icon) {
      update.emoji = applied.icon
    }
  }

  return update
}
