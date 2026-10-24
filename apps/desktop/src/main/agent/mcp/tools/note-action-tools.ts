import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, type ToolName } from './schemas'
import { parse } from './tool-input'

type ToolHandlerContext = Parameters<ToolRegistration['handler']>[1]

export type ApproveArgs = <T>(
  toolName: ToolName,
  parsedArgs: T,
  ctx: ToolHandlerContext
) => Promise<T>

/** What the note action tools use of the vault handles. */
export interface NoteActionHandles {
  notes: Pick<
    VaultServiceHandles['notes'],
    'addTag' | 'removeTag' | 'moveToFolder' | 'copy' | 'read'
  >
  windows: Pick<VaultServiceHandles['windows'], 'insertAtCursor'>
}

type BatchResult<Extra extends object> =
  | ({ id: string; ok: true } & Extra)
  | { id: string; ok: false; error: string }

/**
 * Runs `act` on each id in turn and reports every outcome. One note failing
 * (deleted meanwhile, locked, a filed PDF) must not abandon the rest of a batch
 * the user approved as a whole, and the agent needs to know which ones landed.
 * Sequential on purpose: each write feeds the note's CRDT doc and the index,
 * and a hundred at once would contend for both.
 */
async function runBatch<Extra extends object>(
  ids: string[],
  act: (id: string) => Promise<Extra>
): Promise<{ succeeded: number; failed: number; results: BatchResult<Extra>[] }> {
  const results = await ids.reduce<Promise<BatchResult<Extra>[]>>(async (previous, id) => {
    const done = await previous
    try {
      return [...done, { ...(await act(id)), id, ok: true }]
    } catch (error) {
      return [
        ...done,
        { id, ok: false, error: error instanceof Error ? error.message : String(error) }
      ]
    }
  }, Promise.resolve([]))
  const failed = results.filter((result) => !result.ok).length
  return { succeeded: results.length - failed, failed, results }
}

export function buildNoteActionTools(handles: NoteActionHandles, approve: ApproveArgs) {
  const bulkTag: ToolRegistration = {
    name: 'vault_bulk_tag_notes',
    description: TOOL_SCHEMAS.vault_bulk_tag_notes.description,
    inputSchema: TOOL_SCHEMAS.vault_bulk_tag_notes.input,
    handler: async (input, ctx) => {
      const parsed = parse<{ ids: string[]; add?: string[]; remove?: string[] }>(
        TOOL_SCHEMAS.vault_bulk_tag_notes.input,
        input
      )
      const args = await approve('vault_bulk_tag_notes', parsed, ctx)
      return runBatch(args.ids, async (id) => {
        await Promise.all((args.add ?? []).map(async (tag) => handles.notes.addTag({ id, tag })))
        await Promise.all(
          (args.remove ?? []).map(async (tag) => handles.notes.removeTag({ id, tag }))
        )
        return {}
      })
    }
  }
  const bulkMove: ToolRegistration = {
    name: 'vault_bulk_move_notes',
    description: TOOL_SCHEMAS.vault_bulk_move_notes.description,
    inputSchema: TOOL_SCHEMAS.vault_bulk_move_notes.input,
    handler: async (input, ctx) => {
      const parsed = parse<{ ids: string[]; folder_path: string }>(
        TOOL_SCHEMAS.vault_bulk_move_notes.input,
        input
      )
      const args = await approve('vault_bulk_move_notes', parsed, ctx)
      return runBatch(args.ids, async (id) =>
        handles.notes.moveToFolder({ id, folder_path: args.folder_path })
      )
    }
  }
  const copy: ToolRegistration = {
    name: 'vault_copy_notes',
    description: TOOL_SCHEMAS.vault_copy_notes.description,
    inputSchema: TOOL_SCHEMAS.vault_copy_notes.input,
    handler: async (input, ctx) => {
      const parsed = parse<{ ids: string[]; folder_path: string }>(
        TOOL_SCHEMAS.vault_copy_notes.input,
        input
      )
      const args = await approve('vault_copy_notes', parsed, ctx)
      return runBatch(args.ids, async (id) => {
        const { id: copyId, ...created } = await handles.notes.copy({
          id,
          folder_path: args.folder_path
        })
        return { copy_id: copyId, ...created }
      })
    }
  }
  const insertAtCursor: ToolRegistration = {
    name: 'vault_insert_at_cursor',
    description: TOOL_SCHEMAS.vault_insert_at_cursor.description,
    inputSchema: TOOL_SCHEMAS.vault_insert_at_cursor.input,
    handler: async (input, ctx) => {
      const parsed = parse<{
        id: string
        items: ({ type: 'text'; text: string } | { type: 'note_link'; note_id: string })[]
      }>(TOOL_SCHEMAS.vault_insert_at_cursor.input, input)
      const args = await approve('vault_insert_at_cursor', parsed, ctx)
      // Resolve every link before touching the editor, so a bad id inserts nothing.
      const items = await Promise.all(
        args.items.map(async (item) => {
          if (item.type === 'text') return item
          const note = await handles.notes.read(item.note_id)
          if (!note) throw new Error(`Note not found: ${item.note_id}`)
          return { type: 'wikilink' as const, title: note.title }
        })
      )
      await handles.windows.insertAtCursor(ctx.windowId, { noteId: args.id, items })
      return { id: args.id, inserted: items.length }
    }
  }

  return {
    vault_bulk_tag_notes: bulkTag,
    vault_bulk_move_notes: bulkMove,
    vault_copy_notes: copy,
    vault_insert_at_cursor: insertAtCursor
  }
}
