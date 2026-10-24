import { z } from 'zod'

import { CREATED_FOLDERS_HINT } from './tool-hints'

const idSchema = z.string().min(1)

/** Most notes one bulk tool call touches; keeps the approval card readable. */
const BULK_NOTE_LIMIT = 100

export const NOTE_ACTION_TOOL_SCHEMAS = {
  vault_bulk_tag_notes: {
    input: z
      .object({
        ids: z.array(idSchema).min(1).max(BULK_NOTE_LIMIT),
        add: z.array(z.string().min(1)).max(20).optional(),
        remove: z.array(z.string().min(1)).max(20).optional()
      })
      .refine((value) => (value.add?.length ?? 0) + (value.remove?.length ?? 0) > 0, {
        message: 'Give at least one tag in add or remove.'
      }),
    description:
      `Add and/or remove tags on up to ${BULK_NOTE_LIMIT} notes in one call. ` +
      'Replies with a results list, one entry per id: ok, or the error that note hit. ' +
      'A failure on one note does not stop the rest. Requires one user approval for the whole batch.'
  },
  vault_bulk_move_notes: {
    input: z.object({
      ids: z.array(idSchema).min(1).max(BULK_NOTE_LIMIT),
      folder_path: z.string().min(1)
    }),
    description:
      `Move up to ${BULK_NOTE_LIMIT} notes to one folder. ${CREATED_FOLDERS_HINT} ` +
      'Replies with a results list, one entry per id. A failure on one note does not stop the rest. ' +
      'Requires one user approval for the whole batch.'
  },
  vault_copy_notes: {
    input: z.object({
      ids: z.array(idSchema).min(1).max(BULK_NOTE_LIMIT),
      folder_path: z.string().min(1)
    }),
    description:
      `Copy up to ${BULK_NOTE_LIMIT} markdown notes into one folder of this vault. Each copy gets ` +
      'a new id and keeps the title, body and tags; custom properties are not copied, and links to ' +
      'the original are not rewritten. The originals stay where they are. ' +
      `${CREATED_FOLDERS_HINT} Replies with a results list, one entry per id with the new id. ` +
      'A failure on one note does not stop the rest. Requires one user approval for the whole batch.'
  },
  vault_insert_at_cursor: {
    input: z.object({
      id: idSchema.describe('Id of the note open in the editor, from vault_get_current_note.'),
      items: z
        .array(
          z.discriminatedUnion('type', [
            z.object({ type: z.literal('text'), text: z.string().min(1) }),
            z.object({ type: z.literal('note_link'), note_id: idSchema })
          ])
        )
        .min(1)
        .max(50)
    }),
    description:
      'Insert text and [[wiki-links]] to other notes at the cursor of the note open in the editor. ' +
      "Use note_link with a note id from vault_search_notes; the link shows that note's title. " +
      'Fails when the note is not open in an editor, so call vault_get_current_note first. ' +
      'Does not write the file directly: the editor saves the change like a keystroke. ' +
      'Requires user approval.'
  }
} as const
