import type { MessageStatus } from '@memry/contracts/ipc-agent'

export {
  AssistantContentSchema,
  AttachmentSnapshotSchema,
  MessageAttachmentSchema,
  MessageContentSchema,
  MessageRoleSchema,
  MessageStatusSchema,
  SystemContentSchema,
  ToolCallContentSchema,
  ToolResultContentSchema,
  UserContentSchema,
  type Conversation,
  type FieldClocks,
  type Message,
  type MessageAttachment,
  type MessageContent,
  type MessageRole,
  type MessageStatus,
  type VectorClock
} from '@memry/contracts/ipc-agent'

export const TERMINAL_STATUSES: ReadonlySet<MessageStatus> = new Set([
  'completed',
  'cancelled',
  'error'
])
