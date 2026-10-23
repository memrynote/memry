import type { ZodType } from 'zod'

import type { AgentBackendOptions } from '@memry/contracts/ipc-agent'

import { createLogger } from '../../lib/logger'
import type { AgentBackend } from './types'

const logger = createLogger('Agent:StructuredCompletion')
const STDERR_TAIL_LIMIT = 2000

/** The first balanced JSON object in `text`, tolerating a code fence or prose around it. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('model reply has no JSON object')
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1))
  }
  throw new Error('model reply has an unterminated JSON object')
}

/**
 * One-shot structured completion next to `summarize()`: a single no-tools run of
 * the backend (never a chat turn), drained to the end, whose reply must be one
 * JSON object that `schema` accepts. The backends have no native schema mode,
 * so the prompt asks for JSON and this validates it. Throws on a non-zero exit,
 * an error event, unparsable JSON or a schema mismatch.
 */
export async function completeStructured<T>(input: {
  backend: AgentBackend
  options: AgentBackendOptions
  prompt: string
  schema: ZodType<T>
  windowId?: string
}): Promise<T> {
  const sub = await input.backend.summarize({
    prompt: input.prompt,
    conversationId: 'structured-completion',
    windowId: input.windowId ?? 'structured-completion',
    options: input.options,
    purpose: 'summary'
  })
  // Drain stderr concurrently: a full pipe blocks the child and the run never ends.
  let stderrTail = ''
  const stderrDone = (async () => {
    if (!sub.stderr) return
    try {
      for await (const chunk of sub.stderr) {
        stderrTail = (
          stderrTail + (typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
        ).slice(-STDERR_TAIL_LIMIT)
      }
    } catch (error) {
      logger.warn('Failed to read backend stderr', error)
    }
  })()

  try {
    let text = ''
    let failure: string | null = null
    for await (const event of sub.events) {
      if (event.kind === 'assistant_delta') text += event.text
      else if (event.kind === 'error') failure = event.message
    }
    const exitCode = await sub.waitExit()
    await stderrDone
    if (exitCode !== 0 || failure) {
      throw new Error(
        `${input.backend.id} exited ${exitCode}${failure ? `: ${failure}` : ''}${
          stderrTail ? ` (${stderrTail.trim()})` : ''
        }`
      )
    }
    return input.schema.parse(extractJsonObject(text))
  } finally {
    await sub.cleanup()
  }
}
