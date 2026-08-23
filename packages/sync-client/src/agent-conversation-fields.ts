export const AGENT_CONVERSATION_SYNCABLE_FIELDS = [
  'title',
  'backend',
  'backendModel',
  'trustList',
  'pinned'
] as const

export type AgentConversationField = (typeof AGENT_CONVERSATION_SYNCABLE_FIELDS)[number]
