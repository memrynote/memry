/**
 * Agent fill (board I1): the inline-AI model reads one note and proposes
 * values for the empty fields of its header tags. Nothing here writes: the
 * renderer shows the proposals as ghost values and writes an accepted one
 * through the normal property path.
 */

import { foldTag } from '@memry/shared/tag-fold'
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
  /** The app locale: it decides what `1.500` or `1,5` in a number field means. */
  locale: string
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
  const onlyKey = only ? foldTag(only.trim()) : undefined
  for (const name of note.headerTags) {
    const tag = resolved.get(foldTag(name.trim()))
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

// Only this note is sent: a relation field asks for the name as the note
// writes it, and the name is matched to the vault's notes here, afterwards.
function describeField(field: ResolvedField): string {
  const parts = [`- "${field.name}" (${field.type})`]
  if (field.options?.length) {
    parts.push(`one of: ${field.options.map((option) => `"${option.value}"`).join(', ')}`)
  }
  if (field.type === 'date') parts.push('format YYYY-MM-DD')
  if (field.type === 'number') parts.push('the number as the note writes it')
  if (field.type === 'relation') parts.push(`the name of a #${field.relation!.target}`)
  return parts.join('; ')
}

const escapeRegExp = (char: string): string => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A number as written in `locale`: `1.500` is 1500 where `.` groups thousands
 * and 1.5 where it is the decimal point. A form the locale does not decide (a
 * separator that neither groups three digits nor is the locale's decimal
 * point, like `1,5` in English) is refused, never read as 15.
 */
export function parseLocaleNumber(raw: string, locale: string): number | null {
  const text = raw.replace(/[\s\u00a0\u202f]/g, '').replace(/^\u2212/, '-')
  const parts = new Intl.NumberFormat(locale).formatToParts(12345.6)
  // A space group (French) was stripped with the other spaces above.
  const group = parts.find((part) => part.type === 'group')?.value.replace(/\s/g, '') ?? ''
  const decimal = parts.find((part) => part.type === 'decimal')?.value ?? '.'
  const d = escapeRegExp(decimal)
  const grouped = group
    ? new RegExp(`^-?\\d{1,3}(?:${escapeRegExp(group)}\\d{3})+(?:${d}\\d+)?$`)
    : null
  const plain = new RegExp(`^-?\\d+(?:${d}\\d+)?$`)
  if (grouped?.test(text) || plain.test(text)) {
    const number = Number((group ? text.split(group).join('') : text).replace(decimal, '.'))
    return Number.isFinite(number) ? number : null
  }
  // A `.` decimal point the locale does not use for grouping three digits (`1.5` in Turkish).
  return /^-?\d+\.\d+$/.test(text) ? Number(text) : null
}

/** `YYYY-MM-DD` naming a real day: `2026-02-30` is refused, not rolled into March. */
function isCalendarDate(text: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (!match) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  )
}

function toProposal(
  field: ResolvedField,
  raw: string,
  candidates: ObjectMatch[],
  locale: string
): Omit<FieldFillProposal, 'sourceText'> | null {
  const text = raw.trim()
  if (!text) return null
  switch (field.type) {
    case 'number': {
      const number = parseLocaleNumber(text, locale)
      return number === null ? null : { field: field.name, value: number, display: text }
    }
    case 'date':
      return isCalendarDate(text) ? { field: field.name, value: text, display: text } : null
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
      "Each value is plain text in the field's format. For a relation field give the name of the thing as the note writes it.",
      'sourceText is the one sentence of the note that states the value, copied character for character.'
    ].join(' '),
    prompt: [
      `Title: ${note.title}`,
      'Fields:',
      ...fields.map(describeField),
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
    const proposal = toProposal(field, raw.value, candidatesOf(field), deps.locale)
    if (!proposal) continue
    taken.add(field.name)
    const source = raw.sourceText.trim()
    proposals.push({ ...proposal, sourceText: source && body.includes(source) ? source : '' })
  }
  proposals.sort(
    (a, b) =>
      fields.findIndex((field) => field.name === a.field) -
      fields.findIndex((field) => field.name === b.field)
  )
  return { kind: 'proposals', proposals }
}
