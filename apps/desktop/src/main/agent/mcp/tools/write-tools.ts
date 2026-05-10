import type { ZodTypeAny } from 'zod'

import { AgentToolError } from '../errors'
import type { ToolRegistration } from '../server'
import type { VaultServiceHandles } from './handles'
import { TOOL_SCHEMAS, WRITE_TOOL_NAMES, type ToolName } from './schemas'

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

async function gateOrDeny(gate: WriteToolGate | null, ctx: GateContext): Promise<unknown> {
  if (!gate) {
    throw new AgentToolError(
      'PERMISSION_DENIED',
      'Write tools require an active Memry Agent conversation with an approval gate.'
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
    vault_create_task: {
      name: 'vault_create_task',
      description: TOOL_SCHEMAS.vault_create_task.description,
      inputSchema: TOOL_SCHEMAS.vault_create_task.input,
      handler: async (input, ctx) => {
        const parsed = parse<{
          title: string
          project_id?: string
          due?: string
          priority?: number
          tags?: string[]
          notes?: string
        }>(TOOL_SCHEMAS.vault_create_task.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_create_task',
          parsedArgs: parsed
        })) as typeof parsed
        return handles.tasks.create(args)
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
        const parsed = parse<{
          id: string
          title?: string
          status?: string
          project_id?: string | null
          due?: string | null
          priority?: number
          notes?: string
        }>(TOOL_SCHEMAS.vault_update_task.input, input)
        const args = (await gateOrDeny(gate, {
          conversationId: ctx.conversationId ?? '',
          windowId: ctx.windowId,
          toolName: 'vault_update_task',
          parsedArgs: parsed
        })) as typeof parsed
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
    }
  }

  return WRITE_TOOL_NAMES.map((name) => factories[name])
}
