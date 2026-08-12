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
    GET_BACKEND_STATUSES: 'agent:getBackendStatuses',
    LIST_BACKEND_MODELS: 'agent:listBackendModels',
    GET_LOCAL_PROVIDER_SETTINGS: 'agent:getLocalProviderSettings',
    SET_LOCAL_PROVIDER_SETTINGS: 'agent:setLocalProviderSettings',
    GET_PREFERENCES: 'agent:getPreferences',
    SET_PREFERENCES: 'agent:setPreferences',
    LIST_LOCAL_MODELS: 'agent:listLocalModels',
    TEST_LOCAL_PROVIDER: 'agent:testLocalProvider',
    PROBE_LOCAL_PROVIDER: 'agent:probeLocalProvider',
    ACCEPT_DISCLOSURE: 'agent:acceptDisclosure',
    GET_DISCLOSURE_STATE: 'agent:getDisclosureState',
    GET_WINDOW_ID: 'agent:getWindowId',
    /**
     * The calling window tells main which conversation it currently shows, so
     * per-token `assistant_text_delta` events reach only the windows that can
     * render them. Purely additive: a window that never calls this is treated
     * as "unknown", never as "not interested".
     */
    SET_STREAM_TARGET: 'agent:setStreamTarget'
  },
  events: {
    AGENT_EVENT: 'agent:event',
    /**
     * A conversation row changed outside the live turn stream — today only a
     * sync pull from another device. The renderer must re-read the list; the
     * `agent:event` stream only carries the local turn lifecycle.
     */
    CONVERSATIONS_CHANGED: 'agent:conversations-changed',
    /** A message row for `conversationId` changed via a sync pull. */
    MESSAGES_CHANGED: 'agent:messages-changed'
  }
} as const

export type AgentInvokeChannel = (typeof AgentChannels.invoke)[keyof typeof AgentChannels.invoke]
export type AgentEventChannel = (typeof AgentChannels.events)[keyof typeof AgentChannels.events]

export const AttachmentInputSchema = z.object({
  kind: z.enum([
    'note',
    'folder',
    'task',
    'project',
    'journal',
    'current_note',
    'inbox',
    'calendar_event'
  ]),
  ref_id: z.string(),
  label: z.string()
})
export type AttachmentInput = z.infer<typeof AttachmentInputSchema>

export const ClaudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type ClaudeEffort = z.infer<typeof ClaudeEffortSchema>
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'xhigh'

export const AgentBackendIdSchema = z.enum(['claude_cli', 'codex_cli', 'local_openai_compatible'])
export type AgentBackendId = z.infer<typeof AgentBackendIdSchema>
export const DEFAULT_AGENT_BACKEND_ID: AgentBackendId = 'claude_cli'

export const AgentCliBackendIdSchema = z.enum(['claude_cli', 'codex_cli'])
export type AgentCliBackendId = z.infer<typeof AgentCliBackendIdSchema>

export const CodexReasoningEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh'])
export type CodexReasoningEffort = z.infer<typeof CodexReasoningEffortSchema>

export const AgentAccessModeSchema = z.enum(['vault_only', 'computer_access'])
export type AgentAccessMode = z.infer<typeof AgentAccessModeSchema>

export const AgentTurnPermissionsSchema = z
  .object({
    accessMode: AgentAccessModeSchema.default('vault_only'),
    webSearchEnabled: z.boolean().default(false)
  })
  .strict()
export type AgentTurnPermissions = z.infer<typeof AgentTurnPermissionsSchema>

export const AgentLocalProviderPresetSchema = z.enum(['ollama', 'lm_studio', 'llama_cpp', 'custom'])
export type AgentLocalProviderPreset = z.infer<typeof AgentLocalProviderPresetSchema>

export const AgentBackendOptionsSchema = z
  .discriminatedUnion('backend', [
    z
      .object({
        backend: z.literal('claude_cli'),
        claudeEffort: ClaudeEffortSchema.default(DEFAULT_CLAUDE_EFFORT),
        model: z.string().min(1).optional()
      })
      .strict(),
    z
      .object({
        backend: z.literal('codex_cli'),
        reasoningEffort: CodexReasoningEffortSchema.default('medium'),
        model: z.string().min(1).optional()
      })
      .strict(),
    z
      .object({
        backend: z.literal('local_openai_compatible'),
        model: z.string().min(1).optional(),
        toolsEnabled: z.boolean().optional()
      })
      .strict()
  ])
  .default({ backend: 'claude_cli', claudeEffort: DEFAULT_CLAUDE_EFFORT })
export type AgentBackendOptions = z.infer<typeof AgentBackendOptionsSchema>

export const AgentBackendModelListRequestSchema = z
  .object({
    backend: AgentCliBackendIdSchema
  })
  .strict()
export type AgentBackendModelListRequest = z.infer<typeof AgentBackendModelListRequestSchema>

export const AgentBackendModelOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1)
  })
  .strict()
export type AgentBackendModelOption = z.infer<typeof AgentBackendModelOptionSchema>

export const AgentBackendModelListSchema = z
  .object({
    backend: AgentCliBackendIdSchema,
    supportsCustomModel: z.boolean(),
    models: z.array(AgentBackendModelOptionSchema)
  })
  .strict()
export type AgentBackendModelList = z.infer<typeof AgentBackendModelListSchema>

export const AgentToolApprovalModeSchema = z.enum(['always_accept', 'ask'])
export type AgentToolApprovalMode = z.infer<typeof AgentToolApprovalModeSchema>

export const AgentPreferencesSchema = z
  .object({
    accessMode: AgentAccessModeSchema.default('vault_only'),
    toolApprovalMode: AgentToolApprovalModeSchema.default('always_accept')
  })
  .strict()
export type AgentPreferences = z.infer<typeof AgentPreferencesSchema>

export const AgentPreferencesUpdateSchema = z
  .object({
    accessMode: AgentAccessModeSchema.optional(),
    toolApprovalMode: AgentToolApprovalModeSchema.optional()
  })
  .strict()
export type AgentPreferencesUpdate = z.infer<typeof AgentPreferencesUpdateSchema>

export const AgentLocalProviderSettingsSchema = z
  .object({
    preset: AgentLocalProviderPresetSchema,
    baseUrl: z.string().url(),
    model: z.string(),
    apiKeyConfigured: z.boolean(),
    allowNonLoopback: z.boolean()
  })
  .strict()
export type AgentLocalProviderSettings = z.infer<typeof AgentLocalProviderSettingsSchema>

export const AgentLocalProviderSettingsUpdateSchema = z
  .object({
    preset: AgentLocalProviderPresetSchema,
    baseUrl: z.string().url(),
    model: z.string(),
    allowNonLoopback: z.boolean(),
    apiKey: z.string().optional().nullable(),
    clearApiKey: z.boolean().optional()
  })
  .strict()
export type AgentLocalProviderSettingsUpdate = z.infer<
  typeof AgentLocalProviderSettingsUpdateSchema
>

export const AgentLocalProviderProbeResultSchema = z
  .object({
    connected: z.boolean(),
    modelAvailable: z.boolean(),
    streamingSupported: z.boolean(),
    toolCallingSupported: z.boolean(),
    toolContinuationSupported: z.boolean(),
    toolsEnabled: z.boolean(),
    detail: z.string().nullable()
  })
  .strict()
export type AgentLocalProviderProbeResult = z.infer<typeof AgentLocalProviderProbeResultSchema>

export const AgentLocalModelListSchema = z.object({
  models: z.array(z.string())
})
export type AgentLocalModelList = z.infer<typeof AgentLocalModelListSchema>

export const AgentBackendStatusSchema = z.object({
  backend: AgentBackendIdSchema,
  available: z.boolean(),
  reason: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
  version: z.string().nullable().optional(),
  minimumRequired: z.string().nullable().optional()
})
export type AgentBackendStatus = z.infer<typeof AgentBackendStatusSchema>

export const BackendStatusesResponseSchema = z.object({
  claude_cli: AgentBackendStatusSchema,
  codex_cli: AgentBackendStatusSchema,
  local_openai_compatible: AgentBackendStatusSchema
})
export type BackendStatusesResponse = z.infer<typeof BackendStatusesResponseSchema>

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
export const AgentSourceKindSchema = z.enum([
  'note',
  'task',
  'inbox',
  'journal',
  'calendar_event',
  'project',
  'folder'
])
export type AgentSourceKind = z.infer<typeof AgentSourceKindSchema>

export const AgentSourceRefSchema = z
  .object({
    kind: AgentSourceKindSchema,
    id: z.string().min(1),
    title: z.string().min(1),
    href: z.string().min(1),
    icon: z.string().min(1).nullable().optional(),
    itemType: z.string().min(1).optional(),
    visualType: z.string().min(1).optional()
  })
  .strict()
export type AgentSourceRef = z.infer<typeof AgentSourceRefSchema>

export const AssistantContentSchema = z.object({
  text: z.string(),
  sources: z.array(AgentSourceRefSchema).optional()
})
export const ToolCallStatusSchema = z.enum([
  'pending',
  'approved',
  'denied',
  'completed',
  'failed',
  'input-streaming',
  'approval-requested',
  'approval-responded',
  'input-available',
  'output-available',
  'output-error',
  'output-denied'
])
export type ToolCallStatus = z.infer<typeof ToolCallStatusSchema>

export const ToolCallContentSchema = z.object({
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  status: ToolCallStatusSchema,
  approvedArgs: z.record(z.string(), z.unknown()).optional(),
  output: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional()
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
  kind: z.enum([
    'note',
    'folder',
    'task',
    'project',
    'journal',
    'current_note',
    'inbox',
    'calendar_event'
  ]),
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
  backendModel: string | null
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
  backendModel: z.string().nullable(),
  trustList: z.array(z.string()),
  pinned: z.boolean(),
  vectorClock: VectorClockSchema,
  fieldClocks: FieldClocksSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
  deletedAt: z.number().nullable(),
  lastSyncedAt: z.number().nullable()
})

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
  backendOptions: AgentBackendOptionsSchema,
  permissions: AgentTurnPermissionsSchema.optional()
})
export type SendTurnRequest = z.infer<typeof SendTurnRequestSchema>

/** `null` means the window has Agent Chat open but no conversation selected. */
export const AgentStreamTargetRequestSchema = z.object({
  conversationId: z.string().nullable()
})
export type AgentStreamTargetRequest = z.infer<typeof AgentStreamTargetRequestSchema>

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
