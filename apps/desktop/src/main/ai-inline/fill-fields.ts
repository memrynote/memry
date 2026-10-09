/**
 * Agent fill (board I1): the inline-AI model reads one note and proposes
 * values for the empty fields of its header tags. Nothing here writes: the
 * renderer shows the proposals as ghost values and writes an accepted one
 * through the normal property path.
 */

import { createOpenAI } from '@ai-sdk/openai'
import { generateText, Output, type LanguageModel } from 'ai'
import { z } from 'zod'

import type { AIInlineSettings } from '@memry/contracts/ai-inline-channels'
import { formatRelationUri } from '@memry/contracts/relation-uri'
import type { ResolvedField, ResolvedTag } from '@memry/contracts/tag-schema'
import type {
  FieldFillProposal,
  FillFieldsInput,
  FillFieldsResult
} from '@memry/contracts/tag-fill-api'
import type { ObjectMatch } from '@memry/contracts/tag-objects-api'
import { createLogger } from '../lib/logger'
import { createLanguageModel } from './ai-llm-service'
import { fieldFillStatus } from './fill-fields-status'

const logger = createLogger('AI:FillFields')

const MAX_BODY_CHARS = 24_000
const MAX_CANDIDATES = 50

export interface FillNote {
  title: string
  content: string
  headerTags: readonly string[]
  properties: Readonly<Record<string, unknown>>
}

export interface FillFieldsDeps {
  settings: AIInlineSettings
  disclosureAccepted: boolean
  acceptDisclosure: () => void
  getNote: (noteId: string) => Promise<FillNote | null>
  resolved: ReadonlyMap<string, ResolvedTag>
  /** Objects of a relation target tag, the same read as `tags:search-objects`. */
  searchObjects: (tag: string) => ObjectMatch[]
  /** Tests pass a mock model; production builds it from `settings`. */
  model?: LanguageModel
}

/**
 * Ollama speaks only the chat-completions dialect of the OpenAI API, and the
 * provider's default model call targets the Responses API, so structured
 * output needs the chat model there.
 */
function buildModel(settings: AIInlineSettings): LanguageModel {
  if (settings.provider === 'ollama') {
    return createOpenAI({
      baseURL: settings.baseUrl || 'http://localhost:11434/v1',
      apiKey: 'ollama'
    }).chat(settings.model)
  }
  return createLanguageModel(settings)
}

function isFilled(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'string') return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  return true
}

/**
 * Empty fields of the note's header tags, own and inherited, each once. With
 * `only`, just the header tags that are `only` or extend it.
 */
export function emptyFieldsOf(
  note: FillNote,
  resolved: ReadonlyMap<string, ResolvedTag>,
  only?: string
): ResolvedField[] {
  const seen = new Set<string>()
  const fields: ResolvedField[] = []
  const onlyKey = only?.trim().toLowerCase()
  for (const name of note.headerTags) {
    const tag = resolved.get(name.trim().toLowerCase())
    if (!tag?.hasFields) continue
    if (onlyKey && tag.key !== onlyKey && !tag.ancestors.includes(onlyKey)) continue
    for (const field of tag.effectiveFields) {
      if (seen.has(field.name)) continue
      seen.add(field.name)
      if (isFilled(note.properties[field.name])) continue
      // A checkbox has no empty state the note can fill; a relation needs a target.
      if (field.type === 'checkbox') continue
      if (field.type === 'relation' && !field.relation?.target) continue
      fields.push(field)
    }
  }
  return fields
}

const proposalSchema = z.object({
  proposals: z.array(z.object({ field: z.string(), value: z.string(), sourceText: z.string() }))
})

function describeField(field: ResolvedField, candidates: ObjectMatch[]): string {
  const parts = [`- "${field.name}" (${field.type})`]
  if (field.options?.length) {
    parts.push(`one of: ${field.options.map((option) => `"${option.value}"`).join(', ')}`)
  }
  if (field.type === 'date') parts.push('format YYYY-MM-DD')
  if (field.type === 'relation') {
    parts.push(`the name of a #${field.relation!.target}`)
    if (candidates.length > 0) {
      parts.push(`known: ${candidates.map((match) => `"${match.title}"`).join(', ')}`)
    }
  }
  return parts.join('; ')
}

function toProposal(
  field: ResolvedField,
  raw: string,
  candidates: ObjectMatch[]
): Omit<FieldFillProposal, 'sourceText'> | null {
  const text = raw.trim()
  if (!text) return null
  switch (field.type) {
    case 'number': {
      const number = Number(text.replace(/,/g, ''))
      return Number.isFinite(number) ? { field: field.name, value: number, display: text } : null
    }
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(text))
        ? { field: field.name, value: text, display: text }
        : null
    case 'select':
    case 'status': {
      const option = field.options?.find((o) => o.value.toLowerCase() === text.toLowerCase())
      return option ? { field: field.name, value: option.value, display: option.value } : null
    }
    case 'multiselect': {
      const values = text
        .split(',')
        .map((part) =>
          field.options?.find((o) => o.value.toLowerCase() === part.trim().toLowerCase())
        )
        .filter((option): option is NonNullable<typeof option> => option !== undefined)
        .map((option) => option.value)
      return values.length > 0
        ? { field: field.name, value: values, display: values.join(', ') }
        : null
    }
    case 'relation': {
      const match = candidates.find((c) => c.title.trim().toLowerCase() === text.toLowerCase())
      if (match) {
        return {
          field: field.name,
          value: [formatRelationUri('note', match.noteId)],
          display: match.title
        }
      }
      return {
        field: field.name,
        value: null,
        display: text,
        create: { title: text, tag: field.relation!.target! }
      }
    }
    default:
      return { field: field.name, value: text, display: text }
  }
}

/** The proposals for one note's empty fields. Never writes. */
export async function fillFields(
  deps: FillFieldsDeps,
  input: FillFieldsInput
): Promise<FillFieldsResult> {
  const status = fieldFillStatus(deps.settings, deps.disclosureAccepted)
  if (!status.available) return { kind: 'unavailable' }
  if (!status.disclosureAccepted) {
    if (!input.acceptDisclosure) {
      return { kind: 'disclosure-required', model: status.model, local: status.local }
    }
    deps.acceptDisclosure()
  }

  const note = await deps.getNote(input.noteId)
  if (!note) return { kind: 'proposals', proposals: [] }
  const fields = emptyFieldsOf(note, deps.resolved, input.tag)
  const body = note.content.trim()
  if (fields.length === 0 || body.length === 0) return { kind: 'proposals', proposals: [] }

  const candidates = new Map<string, ObjectMatch[]>()
  for (const field of fields) {
    const target = field.relation?.target
    if (field.type !== 'relation' || !target || candidates.has(target)) continue
    candidates.set(target, deps.searchObjects(target).slice(0, MAX_CANDIDATES))
  }
  const candidatesOf = (field: ResolvedField): ObjectMatch[] =>
    candidates.get(field.relation?.target ?? '') ?? []

  logger.info('Field fill request', { fields: fields.length })
  const { output } = await generateText({
    model: deps.model ?? buildModel(deps.settings),
    output: Output.object({ schema: proposalSchema }),
    system: [
      'You fill empty fields of a note from what the note itself says.',
      'Propose a value only when the note states it; never guess or invent. Leave out a field the note does not answer.',
      "Each value is plain text in the field's format. For a relation field give the name of the thing; prefer one of the known names when the note means it.",
      'sourceText is the one sentence of the note that states the value, copied character for character.'
    ].join(' '),
    prompt: [
      `Title: ${note.title}`,
      'Fields:',
      ...fields.map((field) => describeField(field, candidatesOf(field))),
      '',
      'Note:',
      body.slice(0, MAX_BODY_CHARS)
    ].join('\n')
  })

  const byName = new Map(fields.map((field) => [field.name.toLowerCase(), field]))
  const proposals: FieldFillProposal[] = []
  const taken = new Set<string>()
  for (const raw of output.proposals) {
    const field = byName.get(raw.field.trim().toLowerCase())
    if (!field || taken.has(field.name)) continue
    const proposal = toProposal(field, raw.value, candidatesOf(field))
    if (!proposal) continue
    taken.add(field.name)
    const source = raw.sourceText.trim()
    proposals.push({ ...proposal, sourceText: source && body.includes(source) ? source : '' })
  }
  // Panel order, not the model's.
  proposals.sort(
    (a, b) =>
      fields.findIndex((field) => field.name === a.field) -
      fields.findIndex((field) => field.name === b.field)
  )
  return { kind: 'proposals', proposals }
}
