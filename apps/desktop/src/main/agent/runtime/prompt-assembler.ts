import type { Message, MessageAttachment } from '../storage/types'

export const SYSTEM_PROMPT_HEADER =
  "You are the Memry agent. You can read the user's vault and create or update notes/tasks/journals/inbox via the memry MCP tools. Each create or update is gated by the user's explicit approval. Read tools are free to call. When the user references a folder, use vault.list_folder and vault.read_note to drill in. Be concise."

export interface AssembleInput {
  history: Message[]
  userMessage: string
  attachments: MessageAttachment[]
}

export function assemblePrompt(input: AssembleInput): string {
  const lines: string[] = [SYSTEM_PROMPT_HEADER, '']

  if (input.attachments.length > 0) {
    lines.push('--- Attached references ---')
    for (const attachment of input.attachments) {
      lines.push(...renderAttachment(attachment))
      lines.push('')
    }
  }

  if (input.history.length > 0) {
    lines.push('--- Prior turns ---')
    for (const message of compactedHistory(input.history)) {
      lines.push(...renderMessage(message))
    }
    lines.push('')
  }

  lines.push(`User: ${input.userMessage}`)
  return lines.join('\n')
}

function compactedHistory(history: Message[]): Message[] {
  const sorted = [...history].sort((a, b) => a.createdAt - b.createdAt)
  const latestCompactionIndex = findLatestCompactionIndex(sorted)
  if (latestCompactionIndex === -1) return sorted

  const compaction = sorted[latestCompactionIndex]
  if (compaction.content.role !== 'system') return sorted

  const summarizedThroughId = compaction.content.data.payload.summarizedThroughId
  if (typeof summarizedThroughId !== 'string') return sorted

  const summarizedThroughIndex = sorted.findIndex((message) => message.id === summarizedThroughId)
  if (summarizedThroughIndex === -1) return sorted

  return [
    compaction,
    ...sorted.filter(
      (_, index) => index > summarizedThroughIndex && index !== latestCompactionIndex
    )
  ]
}

function findLatestCompactionIndex(messages: Message[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (
      message.role === 'system' &&
      message.content.role === 'system' &&
      message.content.data.kind === 'compacted'
    ) {
      return index
    }
  }
  return -1
}

function renderAttachment(attachment: MessageAttachment): string[] {
  const snapshot = attachment.snapshot
  if (snapshot.mode === 'inline_note') {
    const lines = [
      `Attached note: ${snapshot.title} (${attachment.refId})`,
      snapshot.contentMarkdown
    ]
    if (snapshot.truncated) {
      lines.push('[truncated; use vault.read_note for full content]')
    }
    return lines
  }

  if (snapshot.mode === 'inline_journal') {
    const lines = [
      `Attached journal entry: ${snapshot.date} (${attachment.refId})`,
      snapshot.contentMarkdown
    ]
    if (snapshot.truncated) {
      lines.push('[truncated; use vault.get_journal_entry for full content]')
    }
    return lines
  }

  if (snapshot.mode === 'inline_task') {
    return [
      `Attached task: ${snapshot.title} (${attachment.refId}) status=${snapshot.status}${
        snapshot.due ? ` due=${snapshot.due}` : ''
      }${snapshot.project ? ` project=${snapshot.project}` : ''}`
    ]
  }

  if (snapshot.mode === 'inline_project') {
    return [
      `Attached project: ${snapshot.name} (${attachment.refId})${
        snapshot.taskCount ? ` tasks=${snapshot.taskCount}` : ''
      }`
    ]
  }

  if (attachment.kind === 'folder') {
    return [
      `Attached folder reference: ${snapshot.path ?? attachment.refId} - use vault.list_folder to drill in`
    ]
  }

  return [`Attached reference: ${attachment.label} (${attachment.refId})`]
}

function renderMessage(message: Message): string[] {
  if (message.role === 'user' && message.content.role === 'user') {
    return [`User: ${message.content.data.text}`]
  }

  if (message.role === 'assistant' && message.content.role === 'assistant') {
    return [`Assistant: ${message.content.data.text}`]
  }

  if (message.role === 'tool_call' && message.content.role === 'tool_call') {
    return [
      `Tool call: ${message.content.data.tool}`,
      `Args: ${JSON.stringify(message.content.data.args)}`,
      `Status: ${message.content.data.status}`
    ]
  }

  if (message.role === 'tool_result' && message.content.role === 'tool_result') {
    if (message.content.data.ok) {
      return [`Tool result: ${JSON.stringify(message.content.data.data)}`]
    }
    return [`Tool error: ${JSON.stringify(message.content.data.error)}`]
  }

  if (message.role === 'system' && message.content.role === 'system') {
    if (message.content.data.kind === 'compacted') {
      const summary = message.content.data.payload.summary
      return [typeof summary === 'string' ? summary : 'Earlier in this conversation: compacted.']
    }

    return [
      `System (${message.content.data.kind}): ${JSON.stringify(message.content.data.payload)}`
    ]
  }

  return []
}
