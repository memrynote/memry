/**
 * Writing tools contract.
 *
 * `generateAssist` is a one-shot request to the user's inline-AI model. It
 * never edits the note: alternatives come back as strings the user picks from.
 */

import { z } from 'zod'

export const WRITING_ASSIST_MAX_ALTERNATIVES = 5
const MAX_SELECTION_CHARS = 4_000
const MAX_CONTEXT_CHARS = 8_000

export const WritingAssistInputSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('alternatives'),
    text: z.string().trim().min(1).max(MAX_SELECTION_CHARS),
    context: z.string().max(MAX_CONTEXT_CHARS)
  })
])
export type WritingAssistInput = z.infer<typeof WritingAssistInputSchema>

export type WritingAssistResult = { kind: 'alternatives'; alternatives: string[] }

export type WritingAssistResponse =
  { success: true; result: WritingAssistResult } | { success: false; error: string }

/** The spelling data main forwards for a context menu the note editor claimed. */
export interface EditorContextMenuSpelling {
  misspelledWord: string
  dictionarySuggestions: string[]
}

export const AddWordToDictionaryInputSchema = z.string().trim().min(1).max(100)
