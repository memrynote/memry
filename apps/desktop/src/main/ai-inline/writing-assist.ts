import { APICallError, generateText, Output, RetryError } from 'ai'
import { z } from 'zod'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import {
  WRITING_ASSIST_MAX_ALTERNATIVES,
  type WritingAssistInput,
  type WritingAssistResult
} from '@memry/contracts/writing-tools-api'
import { createLogger } from '../lib/logger'
import { createLanguageModel } from './ai-llm-service'

const logger = createLogger('AI:WritingAssist')

const alternativesSchema = z.object({ alternatives: z.array(z.string()) })

/**
 * One structured-output call per request. The model only ever proposes text:
 * nothing here touches the note.
 */
// oxlint-disable-next-line typescript/consistent-return -- exhaustive switch over a closed union: TS rejects a missing case, and a default would invent behavior for kinds that cannot occur
export async function runWritingAssist(
  settings: AIInlineSettings,
  input: WritingAssistInput
): Promise<WritingAssistResult> {
  const model = createLanguageModel(settings)
  logger.info('Writing assist request', { kind: input.kind })

  switch (input.kind) {
    case 'alternatives': {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: alternativesSchema }),
        system: [
          'You suggest alternative wordings for a passage the user selected in their note. Each alternative must be able to replace the selection verbatim in the surrounding sentence: same meaning, same language, same grammatical role, similar length unless shorter reads better.',
          `Return up to ${WRITING_ASSIST_MAX_ALTERNATIVES} distinct alternatives. No explanations, numbering or quotation marks.`
        ].join(' '),
        prompt: `Surrounding text:\n${input.context}\n\nSelection to rephrase:\n${input.text}`
      })
      return {
        kind: 'alternatives',
        alternatives: cleanAlternatives(output.alternatives, input.text)
      }
    }
  }
}

export type WritingAssistFailure = 'unreachable' | 'unauthorized' | 'other'

/**
 * Classifies a provider failure so the user sees what to fix. The SDK wraps
 * retried calls in a RetryError; a fetch that never got a response is an
 * APICallError with no status code ("Cannot connect to API").
 */
export function classifyWritingAssistFailure(error: unknown): WritingAssistFailure {
  const cause = RetryError.isInstance(error) ? error.lastError : error
  if (!APICallError.isInstance(cause)) return 'other'
  if (cause.statusCode === undefined) return 'unreachable'
  if (cause.statusCode === 401 || cause.statusCode === 403) return 'unauthorized'
  return 'other'
}

export function cleanAlternatives(candidates: string[], original: string): string[] {
  const seen = new Set([original.trim()])
  const result: string[] = []
  for (const candidate of candidates) {
    const text = candidate
      .trim()
      .replace(/^["“'‘]+|["”'’]+$/g, '')
      .trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    result.push(text)
    if (result.length === WRITING_ASSIST_MAX_ALTERNATIVES) break
  }
  return result
}
