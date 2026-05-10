import { z } from 'zod'

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
    ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
    GET_DISCLOSURE_STATE: 'agent:getDisclosureState'
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

export const SendTurnRequestSchema = z.object({
  conversationId: z.string(),
  sourceWindowId: z.string(),
  text: z.string(),
  attachments: z.array(AttachmentInputSchema)
})
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

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

export const AgentEventSchema = z.discriminatedUnion('kind', [
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
