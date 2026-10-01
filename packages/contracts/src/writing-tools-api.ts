/**
 * Writing tools contract.
 *
 * `generateAssist` is a one-shot request to the user's inline-AI model. It
 * never edits the note: alternatives come back as strings the user picks
 * from, and both the style check and trim answer with verbatim quotes the
 * renderer matches back to ranges in the editor (unmatched quotes are dropped
 * there). Trim only ever proposes cuts, never rewrites.
 */

import { z } from 'zod'

export const WRITING_ASSIST_MAX_ALTERNATIVES = 5
const MAX_SELECTION_CHARS = 4_000
const MAX_CONTEXT_CHARS = 8_000
const MAX_DOCUMENT_CHARS = 120_000

export const WritingCheckKindSchema = z.enum(['convoluted', 'tone'])
export type WritingCheckKind = z.infer<typeof WritingCheckKindSchema>

export const WritingTrimLevelSchema = z.enum(['slight', 'tighten', 'sharper', 'half'])
export type WritingTrimLevel = z.infer<typeof WritingTrimLevelSchema>

export const WritingAssistInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('alternatives'),
    text: z.string().trim().min(1).max(MAX_SELECTION_CHARS),
    context: z.string().max(MAX_CONTEXT_CHARS)
  }),
  z.object({
    kind: z.literal('check'),
    check: WritingCheckKindSchema,
    markdown: z.string().trim().min(1).max(MAX_DOCUMENT_CHARS)
  }),
  z.object({
    kind: z.literal('trim'),
    level: WritingTrimLevelSchema,
    markdown: z.string().trim().min(1).max(MAX_DOCUMENT_CHARS)
  })
])
export type WritingAssistInput = z.infer<typeof WritingAssistInputSchema>

export interface WritingCheckFinding {
  /** Verbatim text from the note */
  quote: string
  reason: string
}

export interface WritingTrimCut {
  /** Verbatim text from the note to delete */
  quote: string
}

export type WritingAssistResult =
  | { kind: 'alternatives'; alternatives: string[] }
  | { kind: 'check'; findings: WritingCheckFinding[] }
  | { kind: 'trim'; cuts: WritingTrimCut[] }

export type WritingAssistResponse =
  { success: true; result: WritingAssistResult } | { success: false; error: string }

/** The spelling data main forwards for a context menu the note editor claimed. */
export interface EditorContextMenuSpelling {
  misspelledWord: string
  dictionarySuggestions: string[]
}

export const AddWordToDictionaryInputSchema = z.string().trim().min(1).max(100)
