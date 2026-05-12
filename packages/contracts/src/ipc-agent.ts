import { z } from 'zod'

import {
  FieldClocksSchema,
  VectorClockSchema,
  type FieldClocks,
  type VectorClock
} from './sync-api'

export type { FieldClocks, VectorClock }

export const AgentChannels = {
  invoke: {
    LIST_CONVERSATIONS: 'agent:listConversations',
    CREATE_CONVERSATION: 'agent:createConversation',
    LOAD_CONVERSATION: 'agent:loadConversation',
    SEND_TURN: 'agent:sendTurn',
    CANCEL_TURN: 'agent:cancelTurn',
    APPROVE_TOOL: 'agent:approveTool',
    PREVIEW_DIFF: 'agent:previewDiff',
    EDIT_TRUST_LIST: 'agent:editTrustList',
    GET_BINARY_STATUS: 'agent:getBinaryStatus',
    GET_BACKEND_STATUSES: 'agent:getBackendStatuses',
    ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
    GET_DISCLOSURE_STATE: 'agent:getDisclosureState',
    GET_WINDOW_ID: 'agent:getWindowId'
  },
  events: {
    AGENT_EVENT: 'agent:event'
  }
} as const

export type AgentInvokeChannel = (typeof AgentChannels.invoke)[keyof typeof AgentChannels.invoke]
export type AgentEventChannel = (typeof AgentChannels.events)[keyof typeof AgentChannels.events]

export const AttachmentInputSchema = z.object({
  kind: z.enum(['note', 'folder', 'task', 'project', 'journal', 'current_note']),
  ref_id: z.string(),
  label: z.string()
})
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>

export const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type ClaudeEffort = z.infer<typeof ClaudeEffortSchema>
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'xhigh'

export const AgentBackendIdSchema = z.enum(['claude_cli', 'codex_cli'])
export type AgentBackendId = z.infer<typeof AgentBackendIdSchema>
export const DEFAULT_AGENT_BACKEND: AgentBackendId = 'claude_cli'

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

export interface Conversation {
  id: string
  vaultId: string
  title: string
  backend: AgentBackendId
  trustList: string[]
  pinned: boolean
  vectorClock: VectorClock
  fieldClocks: FieldClocks
  createdAt: number
  updatedAt: number
  deletedAt: number | null
  lastSyncedAt: number | null
}

export const ConversationSchema = z.object({
  id: z.string(),
  vaultId: z.string(),
  title: z.string(),
  backend: AgentBackendIdSchema,
  trustList: z.array(z.string()),
  pinned: z.boolean(),
  vectorClock: VectorClockSchema,
  fieldClocks: FieldClocksSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
  lastSyncedAt: z.number().nullable()
})

export const CreateConversationRequestSchema = z.object({
  vaultId: z.string().optional(),
  backend: AgentBackendIdSchema.default(DEFAULT_AGENT_BACKEND)
})
export type CreateConversationRequest = z.input<typeof CreateConversationRequestSchema>

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

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: MessageRoleSchema,
  content: MessageContentSchema,
  toolCallId: z.string().nullable(),
  attachments: z.array(MessageAttachmentSchema),
  status: MessageStatusSchema,
  vectorClock: VectorClockSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable()
})

export const SendTurnRequestSchema = z.object({
  conversationId: z.string(),
  sourceWindowId: z.string(),
  text: z.string(),
  attachments: z.array(AttachmentInputSchema),
  claudeEffort: ClaudeEffortSchema.default(DEFAULT_CLAUDE_EFFORT)
})
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

export const SendTurnResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional()
})
export type SendTurnResponse = z.infer<typeof SendTurnResponseSchema>

export const ApproveToolDecisionSchema = z.union([
  z.object({ kind: z.literal('allow') }),
  z.object({ kind: z.literal('allow_always') }),
  z.object({ kind: z.literal('edit_allow'), editedArgs: z.unknown() }),
  z.object({ kind: z.literal('deny') })
])
export type ApproveToolDecision = z.infer<typeof ApproveToolDecisionSchema>

export const ApproveToolRequestSchema = z.object({
  conversationId: z.string(),
  toolCallId: z.string(),
  decision: ApproveToolDecisionSchema
})
export type ApproveToolRequest = z.infer<typeof ApproveToolRequestSchema>

export const PreviewDiffRequestSchema = z.object({
  conversationId: z.string(),
  toolCallId: z.string()
})
export type PreviewDiffRequest = z.infer<typeof PreviewDiffRequestSchema>

export const PreviewDiffResponseSchema = z.object({
  title: z.string(),
  current: z.string(),
  candidate: z.string()
})
export type PreviewDiffResponse = z.infer<typeof PreviewDiffResponseSchema>

export const BinaryStatusSchema = z.object({
  detected: z.boolean(),
  version: z.string().nullable(),
  meetsMinimum: z.boolean(),
  minimumRequired: z.string(),
  installHint: z.string().nullable()
})
export type BinaryStatus = z.infer<typeof BinaryStatusSchema>

export const BackendStatusesResponseSchema = z.object({
  claude_cli: BinaryStatusSchema,
  codex_cli: BinaryStatusSchema
})
export type BackendStatusesResponse = z.infer<typeof BackendStatusesResponseSchema>

export const AgentEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message_upserted'),
    message: MessageSchema
  }),
  z.object({
    kind: z.literal('conversation_updated'),
    conversation: ConversationSchema
  }),
  z.object({
    kind: z.literal('assistant_text_delta'),
    conversationId: z.string(),
    messageId: z.string(),
    text: z.string()
  }),
  z.object({
    kind: z.literal('tool_call_started'),
    conversationId: z.string(),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown()
  }),
  z.object({
    kind: z.literal('tool_call_pending_approval'),
    conversationId: z.string(),
    toolCallId: z.string(),
    name: z.string(),
    args: z.unknown(),
    requiresDiff: z.boolean()
  }),
  z.object({
    kind: z.literal('tool_call_completed'),
    conversationId: z.string(),
    toolCallId: z.string(),
    result: z.unknown()
  }),
  z.object({
    kind: z.literal('tool_call_failed'),
    conversationId: z.string(),
    toolCallId: z.string(),
    error: z.object({ code: z.string(), message: z.string() })
  }),
  z.object({ kind: z.literal('turn_completed'), conversationId: z.string(), turnId: z.string() }),
  z.object({ kind: z.literal('turn_cancelled'), conversationId: z.string(), turnId: z.string() }),
  z.object({
    kind: z.literal('turn_error'),
    conversationId: z.string(),
    turnId: z.string(),
    message: z.string()
  })
])
export type AgentEvent = z.infer<typeof AgentEventSchema>
