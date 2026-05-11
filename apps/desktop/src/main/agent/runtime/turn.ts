import { randomUUID } from 'node:crypto'

import { createLogger } from '../../lib/logger'
import { createStreamParser } from '../cli/stream-parser'
import type { BackendEvent } from '../cli/types'
import type { ConversationStore } from '../storage/conversation-store'
import type { MessageStore } from '../storage/message-store'
import type { MessageAttachment } from '../storage/types'
import { broadcastAgentEvent } from './event-bus'
import { maybeCompact } from './compactor'
import { assemblePrompt } from './prompt-assembler'
import { COMPACTION_THRESHOLD, estimateTokens } from './token-estimator'

const logger = createLogger('AgentRuntime:Turn')

export interface TurnDeps {
  conversations: ConversationStore
  messages: MessageStore
  spawnSubprocess: (input: {
    prompt: string
    conversationId: string
    windowId: string
  }) => Promise<{
    stdout: AsyncIterable<Buffer>
    stderr: AsyncIterable<Buffer>
    pid: number
    kill: () => void
    waitExit: () => Promise<number>
    cleanup: () => Promise<void>
  }>
  toolHandlers: {
    routeToolCall: (input: {
      conversationId: string
      windowId: string
      toolUseId: string
      name: string
      args: unknown
    }) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>
  }
}

export interface RunTurnInput {
  conversationId: string
  sourceWindowId: string
  text: string
  attachments: MessageAttachment[]
}

export async function runTurn(deps: TurnDeps, input: RunTurnInput): Promise<{ turnId: string }> {
  const turnId = randomUUID()

  const user = deps.messages.append({
    conversationId: input.conversationId,
    role: 'user',
    content: { role: 'user', data: { text: input.text } },
    attachments: input.attachments,
    status: 'completed'
  })
  broadcastAgentEvent({
    kind: 'message_upserted',
    message: user
  })

  let history = deps.messages
    .listByConversation(input.conversationId)
    .filter((message) => message.id !== user.id)
  const prompt = assemblePrompt({
    history,
    userMessage: input.text,
    attachments: input.attachments
  })

  await maybeCompact({
    conversationId: input.conversationId,
    messages: deps.messages,
    summarize: (toSummarize) =>
      summarizeWithSubprocess(deps, {
        prompt: toSummarize,
        conversationId: input.conversationId,
        windowId: input.sourceWindowId
      }),
    estimateLimit: COMPACTION_THRESHOLD,
    currentEstimate: estimateTokens(prompt)
  })

  history = deps.messages
    .listByConversation(input.conversationId)
    .filter((message) => message.id !== user.id)
  const compactedPrompt = assemblePrompt({
    history,
    userMessage: input.text,
    attachments: input.attachments
  })

  const sub = await deps.spawnSubprocess({
    prompt: compactedPrompt,
    conversationId: input.conversationId,
    windowId: input.sourceWindowId
  })
  const stderrTextPromise = collectStreamText(sub.stderr)

  const assistant = deps.messages.append({
    conversationId: input.conversationId,
    role: 'assistant',
    content: { role: 'assistant', data: { text: '' } },
    attachments: [],
    status: 'streaming'
  })
  broadcastAgentEvent({
    kind: 'message_upserted',
    message: assistant
  })

  let buffered = ''
  const events: BackendEvent[] = []
  const parser = createStreamParser((event) => {
    events.push(event)
  })

  const drainEvents = async (): Promise<void> => {
    while (events.length > 0) {
      const event = events.shift()
      if (!event) continue
      await handleBackendEvent(deps, event, {
        conversationId: input.conversationId,
        windowId: input.sourceWindowId,
        assistantMessageId: assistant.id,
        onAssistantText: (text) => {
          buffered += text
        }
      })
    }
  }

  try {
    for await (const chunk of sub.stdout) {
      parser.feed(chunk.toString('utf8'))
      await drainEvents()
    }
    parser.flush()
    await drainEvents()
    const exitCode = await sub.waitExit()
    const stderrText = (await stderrTextPromise).trim()

    if (exitCode !== 0) {
      const message = stderrText || `Claude exited with code ${exitCode}`
      logger.warn('Claude subprocess exited non-zero', { exitCode, stderr: stderrText })
      const errored = deps.messages.markTerminal(assistant.id, 'error', {
        content: { role: 'assistant', data: { text: message } }
      })
      broadcastAgentEvent({
        kind: 'message_upserted',
        message: errored
      })
      broadcastAgentEvent({
        kind: 'turn_error',
        conversationId: input.conversationId,
        turnId,
        message
      })
      return { turnId }
    }

    const completed = deps.messages.markTerminal(assistant.id, 'completed', {
      content: { role: 'assistant', data: { text: buffered } }
    })
    broadcastAgentEvent({
      kind: 'message_upserted',
      message: completed
    })

    broadcastAgentEvent({
      kind: 'turn_completed',
      conversationId: input.conversationId,
      turnId
    })
  } finally {
    await sub.cleanup()
  }

  return { turnId }
}

async function summarizeWithSubprocess(
  deps: TurnDeps,
  input: { prompt: string; conversationId: string; windowId: string }
): Promise<string> {
  const sub = await deps.spawnSubprocess(input)
  const events: BackendEvent[] = []
  const parser = createStreamParser((event) => {
    events.push(event)
  })
  let raw = ''
  let summary = ''

  try {
    for await (const chunk of sub.stdout) {
      const text = chunk.toString('utf8')
      raw += text
      parser.feed(text)
      while (events.length > 0) {
        const event = events.shift()
        if (event?.kind === 'assistant_delta') {
          summary += event.text
        }
      }
    }
    parser.flush()
    while (events.length > 0) {
      const event = events.shift()
      if (event?.kind === 'assistant_delta') {
        summary += event.text
      }
    }
    await sub.waitExit()
    return summary.trim() || raw.trim()
  } finally {
    await sub.cleanup()
  }
}

async function collectStreamText(stream: AsyncIterable<Buffer>): Promise<string> {
  let text = ''
  for await (const chunk of stream) {
    text += chunk.toString('utf8')
  }
  return text
}

async function handleBackendEvent(
  deps: TurnDeps,
  event: BackendEvent,
  ctx: {
    conversationId: string
    windowId: string
    assistantMessageId: string
    onAssistantText: (text: string) => void
  }
): Promise<void> {
  if (event.kind === 'assistant_delta') {
    ctx.onAssistantText(event.text)
    broadcastAgentEvent({
      kind: 'assistant_text_delta',
      conversationId: ctx.conversationId,
      messageId: ctx.assistantMessageId,
      text: event.text
    })
    return
  }

  if (event.kind === 'tool_use') {
    broadcastAgentEvent({
      kind: 'tool_call_started',
      conversationId: ctx.conversationId,
      toolCallId: event.toolUseId,
      name: event.name,
      args: event.args
    })
    const result = await deps.toolHandlers.routeToolCall({
      conversationId: ctx.conversationId,
      windowId: ctx.windowId,
      toolUseId: event.toolUseId,
      name: event.name,
      args: event.args
    })
    if (result.ok) {
      broadcastAgentEvent({
        kind: 'tool_call_completed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        result: result.data
      })
    } else {
      broadcastAgentEvent({
        kind: 'tool_call_failed',
        conversationId: ctx.conversationId,
        toolCallId: event.toolUseId,
        error: result.error ?? { code: 'INTERNAL', message: 'unknown' }
      })
    }
    return
  }

  if (event.kind === 'unknown') {
    logger.debug('Unknown backend event', event.raw)
  }
}
