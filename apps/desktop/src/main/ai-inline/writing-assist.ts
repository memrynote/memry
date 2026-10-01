import { generateText, Output } from 'ai'
import { z } from 'zod'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import {
  WRITING_ASSIST_MAX_ALTERNATIVES,
  type WritingAssistInput,
  type WritingAssistResult,
  type WritingCheckKind,
  type WritingTrimLevel
} from '@memry/contracts/writing-tools-api'
import { createLogger } from '../lib/logger'
import { createLanguageModel } from './ai-llm-service'

const logger = createLogger('AI:WritingAssist')

const MAX_FINDINGS = 25
const MAX_CUTS = 200

const QUOTE_RULE =
  'Every quote must be copied character for character from the note: a contiguous span of a single paragraph, with no added punctuation, ellipses or quotation marks.'

const CHECK_PROMPTS: Record<WritingCheckKind, string> = {
  convoluted:
    'Find sentences in the note that are convoluted: hard to follow on first read because of nesting, stacked clauses, ambiguous references or buried meaning. Quote each such sentence and give a short reason (under 15 words).',
  tone: "Find words or short phrases that do not fit the note's overall tone or register (too formal, too casual, jargon, loaded or out-of-place wording). Quote each one and give a short reason (under 15 words)."
}

const TRIM_PROMPTS: Record<WritingTrimLevel, string> = {
  slight:
    'Make a slight trim: remove only clear filler and redundant words, about 5-10% of the text.',
  tighten:
    'Tighten the note: remove filler, redundancy and weak qualifiers, about 15-25% of the text.',
  sharper:
    'Make the note sharper: also cut hedges, asides, repetition and sentences that add little, about 30-40% of the text.',
  half: 'Cut the note to roughly half its length, keeping its essential points.'
}

const alternativesSchema = z.object({ alternatives: z.array(z.string()) })
const checkSchema = z.object({
  findings: z.array(z.object({ quote: z.string(), reason: z.string() }))
})
const trimSchema = z.object({ cuts: z.array(z.object({ quote: z.string() })) })

/**
 * One structured-output call per request. The model only ever proposes text:
 * nothing here touches the note, and the renderer drops any quote it cannot
 * find verbatim in the editor.
 */
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
    case 'check': {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: checkSchema }),
        system: `You review the writing in a user's note. ${CHECK_PROMPTS[input.check]} ${QUOTE_RULE} Return an empty list when nothing qualifies.`,
        prompt: input.markdown
      })
      return {
        kind: 'check',
        findings: output.findings
          .map((finding) => ({ quote: finding.quote.trim(), reason: finding.reason.trim() }))
          .filter((finding) => finding.quote.length > 0)
          .slice(0, MAX_FINDINGS)
      }
    }
    case 'trim': {
      const { output } = await generateText({
        model,
        output: Output.object({ schema: trimSchema }),
        system: `You trim a user's note by proposing deletions only. ${TRIM_PROMPTS[input.level]} Never rewrite, reorder or add words: every cut is text to delete as-is, and what remains must still read correctly. Prefer whole words, phrases, clauses or sentences. Do not cut headings or link text. ${QUOTE_RULE}`,
        prompt: input.markdown
      })
      return {
        kind: 'trim',
        cuts: output.cuts
          .map((cut) => ({ quote: cut.quote }))
          .filter((cut) => cut.quote.trim().length > 0)
          .slice(0, MAX_CUTS)
      }
    }
  }
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
