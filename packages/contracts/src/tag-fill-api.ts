/**
 * Agent fill (board I1): the inline-AI model reads one note and proposes
 * values for its empty fields. Main never writes; the renderer writes an
 * accepted proposal through the normal property path.
 */

import { z } from 'zod'

export const FillFieldsSchema = z.object({
  noteId: z.string().min(1),
  /** Only this tag's group (its own and inherited fields); all field groups when absent. */
  tag: z.string().trim().min(1).max(100).optional(),
  /** The user accepted the first-run disclosure with this request. */
  acceptDisclosure: z.boolean().optional()
})
export type FillFieldsInput = z.infer<typeof FillFieldsSchema>

export interface FieldFillProposal {
  field: string
  /** Ready for a property write; null for a relation whose target must be created first. */
  value: unknown
  /** What the slot shows. */
  display: string
  /** The sentence of the note the value came from; '' when the model's quote is not in the note. */
  sourceText: string
  /** A relation target no object matches: accepting creates a note with this title and tag. */
  create?: { title: string; tag: string }
}

export type FillFieldsResult =
  | { kind: 'proposals'; proposals: FieldFillProposal[] }
  | { kind: 'disclosure-required'; model: string; local: boolean }
  | { kind: 'unavailable' }
  | { kind: 'failed'; message: string }

/** Whether "Fill from note" shows, and what the first-run disclosure names. */
export interface FieldFillStatus {
  /** ai-inline is on with a configured provider. */
  available: boolean
  model: string
  /** The provider runs on this device (Ollama). */
  local: boolean
  disclosureAccepted: boolean
}
