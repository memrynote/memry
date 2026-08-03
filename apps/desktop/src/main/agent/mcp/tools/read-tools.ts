import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, READ_TOOL_NAMES } from './schemas'
import type { AgentMcpDesktopReadOperation } from '@memry/contracts/agent-mcp-channels'
import type { NoteFileType } from '@memry/contracts/search-api'

function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}

export function buildReadTools(handles: VaultServiceHandles): ToolRegistration[] {
  const factories: Record<(typeof READ_TOOL_NAMES)[number], ToolRegistration> = {
    vault_search_notes: {
      name: 'vault_search_notes',
      description: TOOL_SCHEMAS.vault_search_notes.description,
      inputSchema: TOOL_SCHEMAS.vault_search_notes.input,
      handler: async (input) => {
        const a = parse<{
          query: string
          limit?: number
          folder_id?: string
          file_types?: NoteFileType[]
        }>(TOOL_SCHEMAS.vault_search_notes.input, input)
        return handles.notes.search({
          query: a.query,
          limit: a.limit,
          folderId: a.folder_id,
          fileTypes: a.file_types
        })
      }
    },
    vault_read_note: {
      name: 'vault_read_note',
      description: TOOL_SCHEMAS.vault_read_note.description,
      inputSchema: TOOL_SCHEMAS.vault_read_note.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_read_note.input, input)
        const note = await handles.notes.read(a.id)
        if (!note) throw new AgentToolError('NOT_FOUND', `Note ${a.id} not found`, { id: a.id })
        // A filed pdf/image/audio/video indexes as a "note" row (#800). Handing
        // its body to an agent would be binary garbage dressed as markdown, so
        // refuse loudly instead of letting it read or edit one. See #919.
        if (note.file_type !== 'markdown') {
          throw new AgentToolError(
            'VALIDATION',
            `Note ${a.id} is a filed ${note.file_type} file, not a markdown note. ` +
              'vault_read_note returns markdown only.',
            { id: a.id, file_type: note.file_type }
          )
        }
        return note
      }
    },
    vault_list_folder: {
      name: 'vault_list_folder',
      description: TOOL_SCHEMAS.vault_list_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_list_folder.input,
      handler: async (input) => {
        const a = parse<{ path?: string; id?: string; recursive?: boolean }>(
          TOOL_SCHEMAS.vault_list_folder.input,
          input
        )
        return handles.folders.list(a)
      }
    },
    vault_get_current_note: {
      name: 'vault_get_current_note',
      description: TOOL_SCHEMAS.vault_get_current_note.description,
      inputSchema: TOOL_SCHEMAS.vault_get_current_note.input,
      handler: async (_input, ctx) => {
        if (!ctx.windowId) return null
        return handles.windows.snapshotCurrentNote(ctx.windowId)
      }
    },
    vault_list_tasks: {
      name: 'vault_list_tasks',
      description: TOOL_SCHEMAS.vault_list_tasks.description,
      inputSchema: TOOL_SCHEMAS.vault_list_tasks.input,
      handler: async (input) => {
        const a = parse<{
          status?: string
          project_id?: string
          due_before?: string
          tag?: string
          limit?: number
        }>(TOOL_SCHEMAS.vault_list_tasks.input, input)
        return handles.tasks.list(a)
      }
    },
    vault_get_task: {
      name: 'vault_get_task',
      description: TOOL_SCHEMAS.vault_get_task.description,
      inputSchema: TOOL_SCHEMAS.vault_get_task.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_get_task.input, input)
        return handles.tasks.get(a.id)
      }
    },
    vault_list_projects: {
      name: 'vault_list_projects',
      description: TOOL_SCHEMAS.vault_list_projects.description,
      inputSchema: TOOL_SCHEMAS.vault_list_projects.input,
      handler: async () => handles.projects.list()
    },
    vault_get_project: {
      name: 'vault_get_project',
      description: TOOL_SCHEMAS.vault_get_project.description,
      inputSchema: TOOL_SCHEMAS.vault_get_project.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_get_project.input, input)
        return handles.projects.get(a.id)
      }
    },
    vault_list_statuses: {
      name: 'vault_list_statuses',
      description: TOOL_SCHEMAS.vault_list_statuses.description,
      inputSchema: TOOL_SCHEMAS.vault_list_statuses.input,
      handler: async (input) => {
        const a = parse<{ project_id: string }>(TOOL_SCHEMAS.vault_list_statuses.input, input)
        return handles.statuses.list(a.project_id)
      }
    },
    vault_get_journal_entry: {
      name: 'vault_get_journal_entry',
      description: TOOL_SCHEMAS.vault_get_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_get_journal_entry.input,
      handler: async (input) => {
        const a = parse<{ date: string }>(TOOL_SCHEMAS.vault_get_journal_entry.input, input)
        return handles.journal.getByDate(a.date)
      }
    },
    vault_list_journal_entries: {
      name: 'vault_list_journal_entries',
      description: TOOL_SCHEMAS.vault_list_journal_entries.description,
      inputSchema: TOOL_SCHEMAS.vault_list_journal_entries.input,
      handler: async (input) => {
        const a = parse<{ from: string; to: string }>(
          TOOL_SCHEMAS.vault_list_journal_entries.input,
          input
        )
        return handles.journal.listInRange(a)
      }
    },
    vault_list_inbox_items: {
      name: 'vault_list_inbox_items',
      description: TOOL_SCHEMAS.vault_list_inbox_items.description,
      inputSchema: TOOL_SCHEMAS.vault_list_inbox_items.input,
      handler: async (input) => {
        const a = parse<{ unread_only?: boolean }>(TOOL_SCHEMAS.vault_list_inbox_items.input, input)
        return handles.inbox.list(a)
      }
    },
    vault_get_inbox_item: {
      name: 'vault_get_inbox_item',
      description: TOOL_SCHEMAS.vault_get_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_get_inbox_item.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_get_inbox_item.input, input)
        return handles.inbox.get(a.id)
      }
    },
    vault_get_tags: {
      name: 'vault_get_tags',
      description: TOOL_SCHEMAS.vault_get_tags.description,
      inputSchema: TOOL_SCHEMAS.vault_get_tags.input,
      handler: async () => handles.tags.listAll()
    },
    vault_list_canvases: {
      name: 'vault_list_canvases',
      description: TOOL_SCHEMAS.vault_list_canvases.description,
      inputSchema: TOOL_SCHEMAS.vault_list_canvases.input,
      handler: async () => handles.canvas.list()
    },
    vault_read_canvas: {
      name: 'vault_read_canvas',
      description: TOOL_SCHEMAS.vault_read_canvas.description,
      inputSchema: TOOL_SCHEMAS.vault_read_canvas.input,
      handler: async (input) => {
        const a = parse<{ id: string }>(TOOL_SCHEMAS.vault_read_canvas.input, input)
        const canvas = await handles.canvas.read(a.id)
        if (!canvas) {
          throw new AgentToolError('NOT_FOUND', `Canvas ${a.id} not found`, { id: a.id })
        }
        return canvas
      }
    },
    vault_desktop_read: {
      name: 'vault_desktop_read',
      description: TOOL_SCHEMAS.vault_desktop_read.description,
      inputSchema: TOOL_SCHEMAS.vault_desktop_read.input,
      handler: async (input, ctx) => {
        const a = parse<{ operation: AgentMcpDesktopReadOperation; args: unknown[] }>(
          TOOL_SCHEMAS.vault_desktop_read.input,
          input
        )
        return handles.desktop.read(a, ctx.windowId)
      }
    }
  }

  return READ_TOOL_NAMES.map((name) => factories[name])
}
