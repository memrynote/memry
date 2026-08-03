import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, WRITE_TOOL_NAMES, type ToolName } from './schemas'
import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'

export interface GateContext {
  conversationId: string
  windowId: string | null
  toolName: ToolName
  parsedArgs: unknown
}

export type WriteToolGate = (
  ctx: GateContext
) => Promise<{ approved: true; args?: unknown } | { approved: false; reason?: string }>

function parse<T>(schema: ZodTypeAny, input: unknown): T {
  const r = schema.safeParse(input)
  if (!r.success) {
    throw new AgentToolError('VALIDATION', 'Invalid tool input', { issues: r.error.issues })
  }
  return r.data as T
}

type ToolHandlerContext = Parameters<ToolRegistration['handler']>[1]

async function gateOrDeny(gate: WriteToolGate | null, ctx: GateContext): Promise<unknown> {
  if (!gate) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require an active memrynote Agent conversation with an approval gate.'
    )
  }
  if (!ctx.conversationId) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require X-Memry-Conversation header.'
    )
  }
  const decision = await gate(ctx)
  if (!decision.approved) {
    throw new AgentToolError('PERMISSION_DENIED', decision.reason ?? 'User denied request.')
  }
  return decision.args ?? ctx.parsedArgs
}

async function approvedArgs<T>(
  gate: WriteToolGate | null,
  toolName: ToolName,
  parsedArgs: T,
  ctx: ToolHandlerContext
): Promise<T> {
  return (await gateOrDeny(gate, {
    conversationId: ctx.conversationId ?? '',
    windowId: ctx.windowId,
    toolName,
    parsedArgs
  })) as T
}

export function buildWriteTools(
  handles: VaultServiceHandles,
  gate: WriteToolGate | null
): ToolRegistration[] {
  const factories: Record<(typeof WRITE_TOOL_NAMES)[number], ToolRegistration> = {
    vault_create_note: {
      name: 'vault_create_note',
      description: TOOL_SCHEMAS.vault_create_note.description,
      inputSchema: TOOL_SCHEMAS.vault_create_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          title: string
          content_markdown: string
          folder_path?: string
          tags?: string[]
        }>(TOOL_SCHEMAS.vault_create_note.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_note',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.notes.create(args)
      }
    },
    vault_rename_note: {
      name: 'vault_rename_note',
      description: TOOL_SCHEMAS.vault_rename_note.description,
      inputSchema: TOOL_SCHEMAS.vault_rename_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; title: string }>(
          TOOL_SCHEMAS.vault_rename_note.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_rename_note', parsed, ctx)
        return handles.notes.rename(args)
      }
    },
    vault_delete_note: {
      name: 'vault_delete_note',
      description: TOOL_SCHEMAS.vault_delete_note.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_delete_note.input, input)
        const args = await approvedArgs(gate, 'vault_delete_note', parsed, ctx)
        return handles.notes.delete(args.id)
      }
    },
    vault_create_folder: {
      name: 'vault_create_folder',
      description: TOOL_SCHEMAS.vault_create_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_create_folder.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ path: string }>(TOOL_SCHEMAS.vault_create_folder.input, input)
        const args = await approvedArgs(gate, 'vault_create_folder', parsed, ctx)
        return handles.folders.create(args.path)
      }
    },
    vault_rename_folder: {
      name: 'vault_rename_folder',
      description: TOOL_SCHEMAS.vault_rename_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_rename_folder.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ old_path: string; new_path: string }>(
          TOOL_SCHEMAS.vault_rename_folder.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_rename_folder', parsed, ctx)
        return handles.folders.rename(args)
      }
    },
    vault_delete_folder: {
      name: 'vault_delete_folder',
      description: TOOL_SCHEMAS.vault_delete_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_folder.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ path: string }>(TOOL_SCHEMAS.vault_delete_folder.input, input)
        const args = await approvedArgs(gate, 'vault_delete_folder', parsed, ctx)
        return handles.folders.delete(args.path)
      }
    },
    vault_create_task: {
      name: 'vault_create_task',
      description: TOOL_SCHEMAS.vault_create_task.description,
      inputSchema: TOOL_SCHEMAS.vault_create_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['tasks']['create']>[0]>(
          TOOL_SCHEMAS.vault_create_task.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_create_task', parsed, ctx)
        return handles.tasks.create(args)
      }
    },
    vault_delete_task: {
      name: 'vault_delete_task',
      description: TOOL_SCHEMAS.vault_delete_task.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_delete_task.input, input)
        const args = await approvedArgs(gate, 'vault_delete_task', parsed, ctx)
        return handles.tasks.delete(args.id)
      }
    },
    vault_complete_task: {
      name: 'vault_complete_task',
      description: TOOL_SCHEMAS.vault_complete_task.description,
      inputSchema: TOOL_SCHEMAS.vault_complete_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; completed_at?: string }>(
          TOOL_SCHEMAS.vault_complete_task.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_complete_task', parsed, ctx)
        return handles.tasks.complete(args)
      }
    },
    vault_uncomplete_task: {
      name: 'vault_uncomplete_task',
      description: TOOL_SCHEMAS.vault_uncomplete_task.description,
      inputSchema: TOOL_SCHEMAS.vault_uncomplete_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_uncomplete_task.input, input)
        const args = await approvedArgs(gate, 'vault_uncomplete_task', parsed, ctx)
        return handles.tasks.uncomplete(args.id)
      }
    },
    vault_archive_task: {
      name: 'vault_archive_task',
      description: TOOL_SCHEMAS.vault_archive_task.description,
      inputSchema: TOOL_SCHEMAS.vault_archive_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_archive_task.input, input)
        const args = await approvedArgs(gate, 'vault_archive_task', parsed, ctx)
        return handles.tasks.archive(args.id)
      }
    },
    vault_unarchive_task: {
      name: 'vault_unarchive_task',
      description: TOOL_SCHEMAS.vault_unarchive_task.description,
      inputSchema: TOOL_SCHEMAS.vault_unarchive_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_unarchive_task.input, input)
        const args = await approvedArgs(gate, 'vault_unarchive_task', parsed, ctx)
        return handles.tasks.unarchive(args.id)
      }
    },
    vault_move_task: {
      name: 'vault_move_task',
      description: TOOL_SCHEMAS.vault_move_task.description,
      inputSchema: TOOL_SCHEMAS.vault_move_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['tasks']['move']>[0]>(
          TOOL_SCHEMAS.vault_move_task.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_move_task', parsed, ctx)
        return handles.tasks.move(args)
      }
    },
    vault_reorder_tasks: {
      name: 'vault_reorder_tasks',
      description: TOOL_SCHEMAS.vault_reorder_tasks.description,
      inputSchema: TOOL_SCHEMAS.vault_reorder_tasks.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['tasks']['reorder']>[0]>(
          TOOL_SCHEMAS.vault_reorder_tasks.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_reorder_tasks', parsed, ctx)
        return handles.tasks.reorder(args)
      }
    },
    vault_duplicate_task: {
      name: 'vault_duplicate_task',
      description: TOOL_SCHEMAS.vault_duplicate_task.description,
      inputSchema: TOOL_SCHEMAS.vault_duplicate_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_duplicate_task.input, input)
        const args = await approvedArgs(gate, 'vault_duplicate_task', parsed, ctx)
        return handles.tasks.duplicate(args.id)
      }
    },
    vault_convert_task_to_subtask: {
      name: 'vault_convert_task_to_subtask',
      description: TOOL_SCHEMAS.vault_convert_task_to_subtask.description,
      inputSchema: TOOL_SCHEMAS.vault_convert_task_to_subtask.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['tasks']['convertToSubtask']>[0]>(
          TOOL_SCHEMAS.vault_convert_task_to_subtask.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_convert_task_to_subtask', parsed, ctx)
        return handles.tasks.convertToSubtask(args)
      }
    },
    vault_convert_subtask_to_task: {
      name: 'vault_convert_subtask_to_task',
      description: TOOL_SCHEMAS.vault_convert_subtask_to_task.description,
      inputSchema: TOOL_SCHEMAS.vault_convert_subtask_to_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(
          TOOL_SCHEMAS.vault_convert_subtask_to_task.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_convert_subtask_to_task', parsed, ctx)
        return handles.tasks.convertToTask(args.id)
      }
    },
    vault_create_project: {
      name: 'vault_create_project',
      description: TOOL_SCHEMAS.vault_create_project.description,
      inputSchema: TOOL_SCHEMAS.vault_create_project.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['projects']['create']>[0]>(
          TOOL_SCHEMAS.vault_create_project.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_create_project', parsed, ctx)
        return handles.projects.create(args)
      }
    },
    vault_update_project: {
      name: 'vault_update_project',
      description: TOOL_SCHEMAS.vault_update_project.description,
      inputSchema: TOOL_SCHEMAS.vault_update_project.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['projects']['update']>[0]>(
          TOOL_SCHEMAS.vault_update_project.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_update_project', parsed, ctx)
        return handles.projects.update(args)
      }
    },
    vault_delete_project: {
      name: 'vault_delete_project',
      description: TOOL_SCHEMAS.vault_delete_project.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_project.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_delete_project.input, input)
        const args = await approvedArgs(gate, 'vault_delete_project', parsed, ctx)
        return handles.projects.delete(args.id)
      }
    },
    vault_archive_project: {
      name: 'vault_archive_project',
      description: TOOL_SCHEMAS.vault_archive_project.description,
      inputSchema: TOOL_SCHEMAS.vault_archive_project.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_archive_project.input, input)
        const args = await approvedArgs(gate, 'vault_archive_project', parsed, ctx)
        return handles.projects.archive(args.id)
      }
    },
    vault_reorder_projects: {
      name: 'vault_reorder_projects',
      description: TOOL_SCHEMAS.vault_reorder_projects.description,
      inputSchema: TOOL_SCHEMAS.vault_reorder_projects.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['projects']['reorder']>[0]>(
          TOOL_SCHEMAS.vault_reorder_projects.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_reorder_projects', parsed, ctx)
        return handles.projects.reorder(args)
      }
    },
    vault_create_status: {
      name: 'vault_create_status',
      description: TOOL_SCHEMAS.vault_create_status.description,
      inputSchema: TOOL_SCHEMAS.vault_create_status.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['statuses']['create']>[0]>(
          TOOL_SCHEMAS.vault_create_status.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_create_status', parsed, ctx)
        return handles.statuses.create(args)
      }
    },
    vault_update_status: {
      name: 'vault_update_status',
      description: TOOL_SCHEMAS.vault_update_status.description,
      inputSchema: TOOL_SCHEMAS.vault_update_status.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['statuses']['update']>[0]>(
          TOOL_SCHEMAS.vault_update_status.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_update_status', parsed, ctx)
        return handles.statuses.update(args)
      }
    },
    vault_delete_status: {
      name: 'vault_delete_status',
      description: TOOL_SCHEMAS.vault_delete_status.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_status.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_delete_status.input, input)
        const args = await approvedArgs(gate, 'vault_delete_status', parsed, ctx)
        return handles.statuses.delete(args.id)
      }
    },
    vault_reorder_statuses: {
      name: 'vault_reorder_statuses',
      description: TOOL_SCHEMAS.vault_reorder_statuses.description,
      inputSchema: TOOL_SCHEMAS.vault_reorder_statuses.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['statuses']['reorder']>[0]>(
          TOOL_SCHEMAS.vault_reorder_statuses.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_reorder_statuses', parsed, ctx)
        return handles.statuses.reorder(args)
      }
    },
    vault_create_journal_entry: {
      name: 'vault_create_journal_entry',
      description: TOOL_SCHEMAS.vault_create_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_create_journal_entry.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ date: string; content_markdown: string }>(
          TOOL_SCHEMAS.vault_create_journal_entry.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_journal_entry',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.journal.createIfMissing(args)
      }
    },
    vault_update_journal_entry: {
      name: 'vault_update_journal_entry',
      description: TOOL_SCHEMAS.vault_update_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_update_journal_entry.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['journal']['update']>[0]>(
          TOOL_SCHEMAS.vault_update_journal_entry.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_update_journal_entry', parsed, ctx)
        return handles.journal.update(args)
      }
    },
    vault_delete_journal_entry: {
      name: 'vault_delete_journal_entry',
      description: TOOL_SCHEMAS.vault_delete_journal_entry.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_journal_entry.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ date: string }>(TOOL_SCHEMAS.vault_delete_journal_entry.input, input)
        const args = await approvedArgs(gate, 'vault_delete_journal_entry', parsed, ctx)
        return handles.journal.delete(args.date)
      }
    },
    vault_add_to_inbox: {
      name: 'vault_add_to_inbox',
      description: TOOL_SCHEMAS.vault_add_to_inbox.description,
      inputSchema: TOOL_SCHEMAS.vault_add_to_inbox.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ source: string; title: string; content: string }>(
          TOOL_SCHEMAS.vault_add_to_inbox.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_to_inbox',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.inbox.add(args)
      }
    },
    vault_update_inbox_item: {
      name: 'vault_update_inbox_item',
      description: TOOL_SCHEMAS.vault_update_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_update_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['inbox']['update']>[0]>(
          TOOL_SCHEMAS.vault_update_inbox_item.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_update_inbox_item', parsed, ctx)
        return handles.inbox.update(args)
      }
    },
    vault_snooze_inbox_item: {
      name: 'vault_snooze_inbox_item',
      description: TOOL_SCHEMAS.vault_snooze_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_snooze_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<Parameters<VaultServiceHandles['inbox']['snooze']>[0]>(
          TOOL_SCHEMAS.vault_snooze_inbox_item.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_snooze_inbox_item', parsed, ctx)
        return handles.inbox.snooze(args)
      }
    },
    vault_archive_inbox_item: {
      name: 'vault_archive_inbox_item',
      description: TOOL_SCHEMAS.vault_archive_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_archive_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_archive_inbox_item.input, input)
        const args = await approvedArgs(gate, 'vault_archive_inbox_item', parsed, ctx)
        return handles.inbox.archive(args.id)
      }
    },
    vault_unarchive_inbox_item: {
      name: 'vault_unarchive_inbox_item',
      description: TOOL_SCHEMAS.vault_unarchive_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_unarchive_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_unarchive_inbox_item.input, input)
        const args = await approvedArgs(gate, 'vault_unarchive_inbox_item', parsed, ctx)
        return handles.inbox.unarchive(args.id)
      }
    },
    vault_delete_inbox_item: {
      name: 'vault_delete_inbox_item',
      description: TOOL_SCHEMAS.vault_delete_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_delete_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_delete_inbox_item.input, input)
        const args = await approvedArgs(gate, 'vault_delete_inbox_item', parsed, ctx)
        return handles.inbox.delete(args.id)
      }
    },
    vault_add_inbox_tag: {
      name: 'vault_add_inbox_tag',
      description: TOOL_SCHEMAS.vault_add_inbox_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_add_inbox_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; tag: string }>(
          TOOL_SCHEMAS.vault_add_inbox_tag.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_add_inbox_tag', parsed, ctx)
        return handles.inbox.addTag(args)
      }
    },
    vault_remove_inbox_tag: {
      name: 'vault_remove_inbox_tag',
      description: TOOL_SCHEMAS.vault_remove_inbox_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_remove_inbox_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; tag: string }>(
          TOOL_SCHEMAS.vault_remove_inbox_tag.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_remove_inbox_tag', parsed, ctx)
        return handles.inbox.removeTag(args)
      }
    },
    vault_update_note: {
      name: 'vault_update_note',
      description: TOOL_SCHEMAS.vault_update_note.description,
      inputSchema: TOOL_SCHEMAS.vault_update_note.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          id: string
          mode: 'append' | 'prepend' | 'replace'
          content_markdown: string
        }>(TOOL_SCHEMAS.vault_update_note.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_update_note',
          parsedArgs: parsed
        })) as typeof parsed
        await handles.notes.update(args)
        return { id: args.id }
      }
    },
    vault_update_task: {
      name: 'vault_update_task',
      description: TOOL_SCHEMAS.vault_update_task.description,
      inputSchema: TOOL_SCHEMAS.vault_update_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<
          Parameters<VaultServiceHandles['tasks']['update']>[1] & { id: string }
        >(TOOL_SCHEMAS.vault_update_task.input, input)
        const args = await approvedArgs(gate, 'vault_update_task', parsed, ctx)
        const { id, ...patch } = args
        await handles.tasks.update(id, patch)
        return { id }
      }
    },
    vault_add_tag: {
      name: 'vault_add_tag',
      description: TOOL_SCHEMAS.vault_add_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_add_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; kind: 'note' | 'task'; tag: string }>(
          TOOL_SCHEMAS.vault_add_tag.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'note') await handles.notes.addTag({ id: args.id, tag: args.tag })
        else await handles.tasks.addTag({ id: args.id, tag: args.tag })
        return { id: args.id }
      }
    },
    vault_remove_tag: {
      name: 'vault_remove_tag',
      description: TOOL_SCHEMAS.vault_remove_tag.description,
      inputSchema: TOOL_SCHEMAS.vault_remove_tag.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; kind: 'note' | 'task'; tag: string }>(
          TOOL_SCHEMAS.vault_remove_tag.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_remove_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'note') await handles.notes.removeTag({ id: args.id, tag: args.tag })
        else await handles.tasks.removeTag({ id: args.id, tag: args.tag })
        return { id: args.id }
      }
    },
    vault_move_to_folder: {
      name: 'vault_move_to_folder',
      description: TOOL_SCHEMAS.vault_move_to_folder.description,
      inputSchema: TOOL_SCHEMAS.vault_move_to_folder.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; folder_path: string }>(
          TOOL_SCHEMAS.vault_move_to_folder.input,
          input
        )
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_move_to_folder',
          parsedArgs: parsed
        })) as typeof parsed
        await handles.notes.moveToFolder(args)
        return { id: args.id }
      }
    },
    vault_add_canvas_item: {
      name: 'vault_add_canvas_item',
      description: TOOL_SCHEMAS.vault_add_canvas_item.description,
      inputSchema: TOOL_SCHEMAS.vault_add_canvas_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          canvas_id: string
          items: { entity_type: 'note' | 'task' | 'calendar_event'; entity_id: string }[]
        }>(TOOL_SCHEMAS.vault_add_canvas_item.input, input)
        const args = await approvedArgs(gate, 'vault_add_canvas_item', parsed, ctx)
        return handles.canvas.addItems(
          {
            canvasId: args.canvas_id,
            items: args.items.map((item) => ({
              entityType: item.entity_type,
              entityId: item.entity_id
            }))
          },
          ctx.windowId
        )
      }
    },
    vault_remove_canvas_item: {
      name: 'vault_remove_canvas_item',
      description: TOOL_SCHEMAS.vault_remove_canvas_item.description,
      inputSchema: TOOL_SCHEMAS.vault_remove_canvas_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          canvas_id: string
          entity_type: 'note' | 'task' | 'calendar_event'
          entity_id: string
        }>(TOOL_SCHEMAS.vault_remove_canvas_item.input, input)
        const args = await approvedArgs(gate, 'vault_remove_canvas_item', parsed, ctx)
        return handles.canvas.removeItem(
          {
            canvasId: args.canvas_id,
            item: { entityType: args.entity_type, entityId: args.entity_id }
          },
          ctx.windowId
        )
      }
    },
    vault_desktop_write: {
      name: 'vault_desktop_write',
      description: TOOL_SCHEMAS.vault_desktop_write.description,
      inputSchema: TOOL_SCHEMAS.vault_desktop_write.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ operation: AgentMcpDesktopWriteOperation; args: unknown[] }>(
          TOOL_SCHEMAS.vault_desktop_write.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_desktop_write', parsed, ctx)
        return handles.desktop.write(args, ctx.windowId)
      }
    }
  }

  return WRITE_TOOL_NAMES.map((name) => factories[name])
}
