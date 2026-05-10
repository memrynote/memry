import type { MessageStore } from '../storage/message-store'
import type { Message } from '../storage/types'

export const COMPACT_PROMPT =
  'Summarize the following conversation history concisely. Begin your output with "Earlier in this conversation:" and preserve the user\'s intents, decisions, and any task ids or note ids that were created. Skip pleasantries.'

export interface MaybeCompactInput {
  conversationId: string
  messages: MessageStore
  summarize: (toSummarize: string) => Promise<string>
  estimateLimit: number
  currentEstimate: number
}

export async function maybeCompact(input: MaybeCompactInput): Promise<void> {
  if (input.currentEstimate < input.estimateLimit) return

  const all = input.messages
    .listByConversation(input.conversationId)
    .sort((a, b) => a.createdAt - b.createdAt)
  const lastCompactedIndex = findLastCompactedIndex(all)
  const activeHistory = all.slice(lastCompactedIndex + 1)
  if (activeHistory.length < 2) return

  const oldest = activeHistory.slice(0, Math.floor(activeHistory.length / 2))
  const dump = oldest.map(renderForSummary).join('\n')
  const summary = await input.summarize(`${COMPACT_PROMPT}\n\n${dump}`)

  input.messages.append({
    conversationId: input.conversationId,
    role: 'system',
    content: {
      role: 'system',
      data: {
        kind: 'compacted',
        payload: {
          summary,
          summarizedThroughId: oldest[oldest.length - 1].id,
          summarizedAt: Date.now()
        }
      }
    },
    attachments: [],
    status: 'completed'
  })
}

function findLastCompactedIndex(messages: Message[]): number {
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

function renderForSummary(message: Message): string {
  return `[${message.role}] ${JSON.stringify(message.content.data)}`
}
