import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import { assertDesktopApiArgs } from './desktop-api-params'
import { DESKTOP_API_REPLY_CAP } from './desktop-api-reply'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, WRITE_TOOL_NAMES, type ToolName } from './schemas'
import { parse } from './tool-input'
import {
  afterWrite,
  bodyWarnings,
  CRDT_STORE_UNAVAILABLE,
  desktopNoteWrite,
  storedNoteReply,
  tagChanges,
  withStoredNoteContent,
  withWarnings
} from './write-replies'
import type { AgentMcpDesktopWriteOperation } from '@memry/contracts/agent-mcp-channels'
import type { CanvasDrawElement, CanvasElementEdit } from '@memry/contracts/canvas-draw'

export interface GateContext {
  /** Opaque per-turn capability presented by the caller; the gate verifies it. */
  writeGrant: string
  windowId: string | null
  toolName: ToolName
  parsedArgs: unknown
}

export type WriteToolGate = (
  ctx: GateContext
) => Promise<{ approved: true; args?: unknown } | { approved: false; reason?: string }>

type ToolHandlerContext = Parameters<ToolRegistration['handler']>[1]

async function gateOrDeny(gate: WriteToolGate | null, ctx: GateContext): Promise<unknown> {
  if (!gate) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require an active memrynote Agent conversation with an approval gate.'
    )
  }
  if (!ctx.writeGrant) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require an in-flight memrynote Agent turn; no X-Memry-Turn capability was presented.'
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
    writeGrant: ctx.writeGrant ?? '',
    windowId: ctx.windowId,
    toolName,
    parsedArgs
  })) as T
}

export function buildWriteTools(
  handles: VaultServiceHandles,
  gate: WriteToolGate | null
): ToolRegistration[] {
  const storedTask = (id: string) => afterWrite(() => handles.tasks.get(id), { id })
  const storedProject = (id: string) => afterWrite(() => handles.projects.get(id), { id })
  const storedInboxItem = (id: string) => afterWrite(() => handles.inbox.get(id), { id })
  const storedStatus = (id: string) => afterWrite(() => handles.statuses.get(id), { id })

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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_note',
          parsedArgs: parsed
        })) as typeof parsed
        const { id, body, ...written } = await handles.notes.create(args)
        return withWarnings(
          { ...(await storedNoteReply(handles, id)), ...written },
          bodyWarnings(body)
        )
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
        await handles.notes.rename(args)
        return storedNoteReply(handles, args.id)
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
        const { id } = await handles.tasks.create(args)
        return storedTask(id)
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
        await handles.tasks.complete(args)
        return storedTask(args.id)
      }
    },
    vault_uncomplete_task: {
      name: 'vault_uncomplete_task',
      description: TOOL_SCHEMAS.vault_uncomplete_task.description,
      inputSchema: TOOL_SCHEMAS.vault_uncomplete_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_uncomplete_task.input, input)
        const args = await approvedArgs(gate, 'vault_uncomplete_task', parsed, ctx)
        await handles.tasks.uncomplete(args.id)
        return storedTask(args.id)
      }
    },
    vault_archive_task: {
      name: 'vault_archive_task',
      description: TOOL_SCHEMAS.vault_archive_task.description,
      inputSchema: TOOL_SCHEMAS.vault_archive_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_archive_task.input, input)
        const args = await approvedArgs(gate, 'vault_archive_task', parsed, ctx)
        await handles.tasks.archive(args.id)
        return storedTask(args.id)
      }
    },
    vault_unarchive_task: {
      name: 'vault_unarchive_task',
      description: TOOL_SCHEMAS.vault_unarchive_task.description,
      inputSchema: TOOL_SCHEMAS.vault_unarchive_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_unarchive_task.input, input)
        const args = await approvedArgs(gate, 'vault_unarchive_task', parsed, ctx)
        await handles.tasks.unarchive(args.id)
        return storedTask(args.id)
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
        await handles.tasks.move(args)
        return storedTask(args.task_id)
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
        const { ids } = await handles.tasks.reorder(args)
        return { ids, tasks: await Promise.all(ids.map(storedTask)) }
      }
    },
    vault_duplicate_task: {
      name: 'vault_duplicate_task',
      description: TOOL_SCHEMAS.vault_duplicate_task.description,
      inputSchema: TOOL_SCHEMAS.vault_duplicate_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_duplicate_task.input, input)
        const args = await approvedArgs(gate, 'vault_duplicate_task', parsed, ctx)
        const { id } = await handles.tasks.duplicate(args.id)
        return storedTask(id)
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
        await handles.tasks.convertToSubtask(args)
        return storedTask(args.task_id)
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
        await handles.tasks.convertToTask(args.id)
        return storedTask(args.id)
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
        const { id } = await handles.projects.create(args)
        return storedProject(id)
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
        await handles.projects.update(args)
        return storedProject(args.id)
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
        await handles.projects.archive(args.id)
        return storedProject(args.id)
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
        const { ids } = await handles.projects.reorder(args)
        return { ids, projects: await Promise.all(ids.map(storedProject)) }
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
        const { ids } = await handles.statuses.reorder(args)
        return { ids, statuses: await Promise.all(ids.map(storedStatus)) }
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_journal_entry',
          parsedArgs: parsed
        })) as typeof parsed
        const { id, body, ...written } = await handles.journal.createIfMissing(args)
        const stored = await afterWrite(() => handles.journal.stored(args.date), { id })
        return withWarnings({ ...stored, ...written }, bodyWarnings(body))
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
        const { id, body, ...written } = await handles.journal.update(args)
        const stored = await afterWrite(() => handles.journal.stored(args.date), { id })
        return withWarnings({ ...stored, ...written }, bodyWarnings(body))
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_to_inbox',
          parsedArgs: parsed
        })) as typeof parsed
        const { id } = await handles.inbox.add(args)
        return storedInboxItem(id)
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
        await handles.inbox.update(args)
        return storedInboxItem(args.id)
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
        await handles.inbox.snooze(args)
        return storedInboxItem(args.id)
      }
    },
    vault_archive_inbox_item: {
      name: 'vault_archive_inbox_item',
      description: TOOL_SCHEMAS.vault_archive_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_archive_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_archive_inbox_item.input, input)
        const args = await approvedArgs(gate, 'vault_archive_inbox_item', parsed, ctx)
        await handles.inbox.archive(args.id)
        return storedInboxItem(args.id)
      }
    },
    vault_unarchive_inbox_item: {
      name: 'vault_unarchive_inbox_item',
      description: TOOL_SCHEMAS.vault_unarchive_inbox_item.description,
      inputSchema: TOOL_SCHEMAS.vault_unarchive_inbox_item.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string }>(TOOL_SCHEMAS.vault_unarchive_inbox_item.input, input)
        const args = await approvedArgs(gate, 'vault_unarchive_inbox_item', parsed, ctx)
        await handles.inbox.unarchive(args.id)
        return storedInboxItem(args.id)
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
        await handles.inbox.addTag(args)
        return storedInboxItem(args.id)
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
        await handles.inbox.removeTag(args)
        return storedInboxItem(args.id)
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_update_note',
          parsedArgs: parsed
        })) as typeof parsed
        const before = await handles.notes.stored(args.id)
        const { sent, stored, ...written } = await handles.notes.update(args)
        const after = await storedNoteReply(handles, args.id)
        const changes = before && 'tags' in after ? tagChanges(before.tags, after.tags) : {}
        return withWarnings({ ...after, ...changes, ...written }, bodyWarnings({ sent, stored }))
      }
    },
    vault_add_html_artifact: {
      name: 'vault_add_html_artifact',
      description: TOOL_SCHEMAS.vault_add_html_artifact.description,
      inputSchema: TOOL_SCHEMAS.vault_add_html_artifact.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ id: string; title: string; html: string }>(
          TOOL_SCHEMAS.vault_add_html_artifact.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_add_html_artifact', parsed, ctx)
        // Save first: if the note turns out not to be writable the attachment is
        // an unreferenced file, which is harmless; the reverse order would leave
        // a block pointing at nothing.
        const { marker, url } = await handles.notes.saveHtmlAttachment(args)
        const body = await handles.notes.update({
          id: args.id,
          mode: 'append',
          content_markdown: marker
        })
        return withWarnings(
          { ...(await storedNoteReply(handles, args.id)), url },
          bodyWarnings(body)
        )
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
        return storedTask(id)
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_add_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'task') {
          await handles.tasks.addTag({ id: args.id, tag: args.tag })
          return storedTask(args.id)
        }
        await handles.notes.addTag({ id: args.id, tag: args.tag })
        return storedNoteReply(handles, args.id)
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_remove_tag',
          parsedArgs: parsed
        })) as typeof parsed
        if (args.kind === 'task') {
          await handles.tasks.removeTag({ id: args.id, tag: args.tag })
          return storedTask(args.id)
        }
        await handles.notes.removeTag({ id: args.id, tag: args.tag })
        return storedNoteReply(handles, args.id)
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
          writeGrant: ctx.writeGrant ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_move_to_folder',
          parsedArgs: parsed
        })) as typeof parsed
        await handles.notes.moveToFolder(args)
        return storedNoteReply(handles, args.id)
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
    vault_create_canvas: {
      name: 'vault_create_canvas',
      description: TOOL_SCHEMAS.vault_create_canvas.description,
      inputSchema: TOOL_SCHEMAS.vault_create_canvas.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ title?: string }>(TOOL_SCHEMAS.vault_create_canvas.input, input)
        const args = await approvedArgs(gate, 'vault_create_canvas', parsed, ctx)
        // Through the desktop bridge rather than the canvas store directly: the
        // IPC handler is what enqueues the sync item and emits canvas:created,
        // and a canvas created without those is invisible to the sidebar and
        // never reaches the user's other devices.
        return handles.desktop.write(
          { operation: 'canvas.create', args: [{ title: args.title ?? null }] },
          ctx.windowId
        )
      }
    },
    vault_draw_on_canvas: {
      name: 'vault_draw_on_canvas',
      description: TOOL_SCHEMAS.vault_draw_on_canvas.description,
      inputSchema: TOOL_SCHEMAS.vault_draw_on_canvas.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ canvas_id: string; elements: CanvasDrawElement[] }>(
          TOOL_SCHEMAS.vault_draw_on_canvas.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_draw_on_canvas', parsed, ctx)
        return handles.canvas.draw(
          { canvasId: args.canvas_id, elements: args.elements },
          ctx.windowId
        )
      }
    },
    vault_edit_canvas_elements: {
      name: 'vault_edit_canvas_elements',
      description: TOOL_SCHEMAS.vault_edit_canvas_elements.description,
      inputSchema: TOOL_SCHEMAS.vault_edit_canvas_elements.input,
      handler: async (input, ctx) => {
        const parsed = parse<{ canvas_id: string; edits: CanvasElementEdit[] }>(
          TOOL_SCHEMAS.vault_edit_canvas_elements.input,
          input
        )
        const args = await approvedArgs(gate, 'vault_edit_canvas_elements', parsed, ctx)
        return handles.canvas.edit({ canvasId: args.canvas_id, edits: args.edits }, ctx.windowId)
      }
    },
    vault_desktop_write: {
      name: 'vault_desktop_write',
      description: TOOL_SCHEMAS.vault_desktop_write.description,
      inputSchema: TOOL_SCHEMAS.vault_desktop_write.input,
      replyCap: DESKTOP_API_REPLY_CAP,
      handler: async (input, ctx) => {
        const parsed = parse<{ operation: AgentMcpDesktopWriteOperation; args: unknown[] }>(
          TOOL_SCHEMAS.vault_desktop_write.input,
          input
        )
        assertDesktopApiArgs(parsed)
        const args = await approvedArgs(gate, 'vault_desktop_write', parsed, ctx)
        // The byte check compares with the body after the checkbox step (AF-005),
        // so only a respelling by the save itself is reported.
        const request = await handles.desktop.prepareWrite(args)
        const result = await handles.desktop.write(request, ctx.windowId)
        const write = desktopNoteWrite(request.operation, request.args, result)
        if (!write) return result
        const body = await handles.notes.storedBody(write.id, write.sent)
        return withWarnings(withStoredNoteContent(result, body.stored), bodyWarnings(body))
      }
    }
  }

  return WRITE_TOOL_NAMES.map((name) => {
    const tool = factories[name]
    return {
      ...tool,
      handler: async (input, ctx) => {
        const result = await tool.handler(input, ctx)
        // The write has landed: a failed status read must not report it as failed.
        const storeUp = await handles.sync.crdtStoreAvailable().catch(() => true)
        return withWarnings(result, storeUp ? [] : [CRDT_STORE_UNAVAILABLE])
      }
    }
  })
}
