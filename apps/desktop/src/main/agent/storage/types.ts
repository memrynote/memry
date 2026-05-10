import { z } from 'zod'

import type { FieldClocks, VectorClock } from '@memry/contracts/sync-api'

export const MessageRoleSchema = z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'system'])
export type MessageRole = z.infer<typeof MessageRoleSchema>

export const MessageStatusSchema = z.enum([
  'pending',
  'streaming',
  'completed',
  'cancelled',
  'error'
])
export type MessageStatus = z.infer<typeof MessageStatusSchema>

export const TERMINAL_STATUSES: ReadonlySet<MessageStatus> = new Set([
  'completed',
  'cancelled',
  'error'
])

export const UserContentSchema = z.object({ text: z.string() })
export const AssistantContentSchema = z.object({ text: z.string() })
export const ToolCallContentSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: z.enum(['pending', 'approved', 'denied', 'completed', 'failed']),
  approvedArgs: z.record(z.string(), z.unknown()).optional()
})
export const ToolResultContentSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
})
export const SystemContentSchema = z.object({
  kind: z.enum(['context_attached', 'compacted', 'backend_changed']),
  payload: z.record(z.string(), z.unknown())
})

export const MessageContentSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), data: UserContentSchema }),
  z.object({ role: z.literal('assistant'), data: AssistantContentSchema }),
  z.object({ role: z.literal('tool_call'), data: ToolCallContentSchema }),
  z.object({ role: z.literal('tool_result'), data: ToolResultContentSchema }),
  z.object({ role: z.literal('system'), data: SystemContentSchema })
])
export type MessageContent = z.infer<typeof MessageContentSchema>

export const AttachmentSnapshotSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('inline_note'),
    title: z.string(),
    contentMarkdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_journal'),
    date: z.string(),
    contentMarkdown: z.string(),
    truncated: z.boolean()
  }),
  z.object({
    mode: z.literal('inline_task'),
    title: z.string(),
    status: z.string(),
    due: z.string().optional(),
    project: z.string().optional(),
    notes: z.string().optional()
  }),
  z.object({
    mode: z.literal('inline_project'),
    name: z.string(),
    status: z.string().optional(),
    taskCount: z.number().optional()
  }),
  z.object({
    mode: z.literal('reference_only'),
    path: z.string().optional(),
    id: z.string().optional()
  })
])

export const MessageAttachmentSchema = z.object({
  kind: z.enum(['note', 'folder', 'task', 'project', 'journal', 'current_note']),
  refId: z.string(),
  label: z.string(),
  snapshotAt: z.number(),
  snapshot: AttachmentSnapshotSchema
})
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>

export type { VectorClock, FieldClocks }

export interface Conversation {
  id: string
  vaultId: string
  title: string
  backend: string
  trustList: string[]
  pinned: boolean
  vectorClock: VectorClock
  fieldClocks: FieldClocks
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  lastSyncedAt: number | null
}

export interface Message {
  id: string
  conversationId: string
  role: MessageRole
  content: MessageContent
  toolCallId: string | null
  attachments: MessageAttachment[]
  status: MessageStatus
  vectorClock: VectorClock
  createdAt: number
  updatedAt: number
  deletedAt: number | null
}
