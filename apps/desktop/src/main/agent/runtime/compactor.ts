import type { MessageStore } from '../storage/message-store'
import type { Message } from '../storage/types'
import { compactionView, isCompactionMarker } from './compaction-view'

export const COMPACT_PROMPT =
  'Summarize the following conversation history concisely. Begin your output with "Earlier in this conversation:" and preserve the user\'s intents, decisions, and any task ids or note ids that were created. Skip pleasantries.'

export interface MaybeCompactInput {
  conversationId: string
  messages: MessageStore
  /**
   * The conversation transcript the caller already listed, including the turn's
   * own user message. Taken as input rather than re-listed here because every
   * list re-runs two AEAD opens, two JSON.parses and a zod parse per message.
   */
  history: Message[]
  summarize: (toSummarize: string) => Promise<string>
  estimateLimit: number
  currentEstimate: number
}

/**
 * Returns the appended compaction marker, or null when nothing was compacted so
 * the caller can skip re-assembling a prompt that would come out byte-identical.
 */
export async function maybeCompact(input: MaybeCompactInput): Promise<Message | null> {
  if (input.currentEstimate < input.estimateLimit) return null

  // The new summary starts from the conversation's beginning: its input is every
  // summary and uncovered message the prompt shows before the cut, so it replaces
  // them without loss.
  const view = compactionView(input.history)
  const firstActive = view.findLastIndex(isCompactionMarker) + 1
  const activeCount = view.length - firstActive
  if (activeCount < 2) return null

  const toSummarize = view.slice(0, firstActive + Math.floor(activeCount / 2))
  const dump = toSummarize.map(renderForSummary).join('\n')
  const summary = await input.summarize(`${COMPACT_PROMPT}\n\n${dump}`)

  return input.messages.append({
    conversationId: input.conversationId,
    role: 'system',
    content: {
      role: 'system',
      data: {
        kind: 'compacted',
        payload: {
          summary,
          summarizedThroughId: toSummarize[toSummarize.length - 1].id,
          summarizedAt: Date.now(),
          summarizedFromStart: true
        }
      }
    },
    attachments: [],
    status: 'completed'
  })
}

function renderForSummary(message: Message): string {
  // Reasoning, the tools-off note and the step-limit note are display-only. A stored
  // tools-off note would tell later turns that tools are off after the probe passes again.
  if (message.content.role === 'assistant') {
    const {
      reasoning: _reasoning,
      reasoningDurationMs: _duration,
      toolsUnavailable: _toolsUnavailable,
      stepLimitReached: _stepLimitReached,
      ...data
    } = message.content.data
    return `[${message.role}] ${JSON.stringify(data)}`
  }
  if (isCompactionMarker(message) && message.content.role === 'system') {
    const summary = message.content.data.payload.summary
    if (typeof summary === 'string') return `[summary] ${summary}`
  }
  return `[${message.role}] ${JSON.stringify(message.content.data)}`
}
