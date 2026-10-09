import { z } from 'zod'

export const PropertyTypes = {
  TEXT: 'text',
  NUMBER: 'number',
  CHECKBOX: 'checkbox',
  DATE: 'date',
  URL: 'url',
  STATUS: 'status',
  SELECT: 'select',
  MULTISELECT: 'multiselect',
  RELATION: 'relation',
  PROJECT: 'project'
} as const

export type PropertyType = (typeof PropertyTypes)[keyof typeof PropertyTypes]

/**
 * The one frontmatter key that carries project membership. Reserved: its type is
 * always `project`, whatever the definition file or type inference would say.
 * Inference would otherwise read `project: [Alpha]` as a plain array and store it
 * as text, so a note written in Obsidian would render the wrong editor.
 */
export const PROJECT_PROPERTY_KEY = 'project'

export interface SelectOption {
  value: string
  color: string
  default?: boolean
}

export const STATUS_CATEGORY_KEYS = ['todo', 'in_progress', 'done'] as const
export type StatusCategoryKey = (typeof STATUS_CATEGORY_KEYS)[number]

export interface StatusCategory {
  label: string
  options: SelectOption[]
}

export type StatusCategories = Record<StatusCategoryKey, StatusCategory>

export interface PropertyDefinition {
  name: string
  type: PropertyType
  options?: SelectOption[]
  categories?: StatusCategories
  defaultValue?: string
  color?: string
  showOnCalendar?: boolean
}

export const DEFAULT_STATUS_CATEGORIES: StatusCategories = {
  todo: {
    label: 'To-do',
    options: [{ value: 'Not started', color: 'stone', default: true }]
  },
  in_progress: {
    label: 'In progress',
    options: [{ value: 'In Progress', color: 'amber' }]
  },
  done: {
    label: 'Complete',
    options: [
      { value: 'Done', color: 'emerald' },
      { value: 'Abandoned', color: 'rose' }
    ]
  }
}

export const DEFAULT_STATUS_DEFINITION: PropertyDefinition = {
  name: 'status',
  type: PropertyTypes.STATUS,
  categories: DEFAULT_STATUS_CATEGORIES
}

const SelectOptionSchema = z.object({
  value: z.string().min(1),
  color: z.string().min(1),
  default: z.boolean().optional()
})

// Added after the file format shipped. Older builds parse `properties.md` with
// non-strict objects, which drop these keys instead of rejecting the file.
const SharedDefinitionFields = {
  defaultValue: z.string().optional(),
  color: z.string().optional()
}

const StatusCategorySchema = z.object({
  label: z.string().min(1),
  options: z.array(SelectOptionSchema)
})

const StatusPropertySchema = z.object({
  type: z.literal('status'),
  ...SharedDefinitionFields,
  categories: z.object({
    todo: StatusCategorySchema,
    in_progress: StatusCategorySchema,
    done: StatusCategorySchema
  })
})

const SelectPropertySchema = z.object({
  type: z.literal('select'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema)
})

const MultiselectPropertySchema = z.object({
  type: z.literal('multiselect'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema)
})

const TextPropertySchema = z.object({
  type: z.literal('text'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema).optional()
})

const NumberPropertySchema = z.object({
  type: z.literal('number'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema).optional()
})

const CheckboxPropertySchema = z.object({
  type: z.literal('checkbox'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema).optional()
})

const UrlPropertySchema = z.object({
  type: z.literal('url'),
  ...SharedDefinitionFields,
  options: z.array(SelectOptionSchema).optional()
})

const DatePropertySchema = z.object({
  type: z.literal('date'),
  ...SharedDefinitionFields,
  showOnCalendar: z.boolean().optional()
})

const ProjectPropertySchema = z.object({
  type: z.literal('project'),
  ...SharedDefinitionFields
})

/**
 * Types with no `PropertyDefinitionSchema` member, and so never written to a
 * definition store. A `relation` is typed from its value every time — its URIs
 * are self-describing — and persisting one into `.memry/properties.md` would
 * make the file fail `safeParse`, which discards *every* definition in it.
 */
export function isPersistableDefinitionType(type: PropertyType): boolean {
  return type !== PropertyTypes.RELATION
}

export const PropertyDefinitionSchema = z.discriminatedUnion('type', [
  StatusPropertySchema,
  SelectPropertySchema,
  MultiselectPropertySchema,
  TextPropertySchema,
  NumberPropertySchema,
  CheckboxPropertySchema,
  UrlPropertySchema,
  DatePropertySchema,
  ProjectPropertySchema
])

export const PropertyDefinitionsFileSchema = z.object({
  properties: z.record(z.string(), PropertyDefinitionSchema).default({})
})

export type PropertyDefinitionsFileData = z.infer<typeof PropertyDefinitionsFileSchema>

export interface ParsedPropertyDefinitionEntries {
  valid: PropertyDefinitionsFileData['properties']
  /** Entries this build cannot parse, to be written back verbatim. */
  unparsed: Map<string, unknown>
  /** True when a `relation` entry was dropped and the file needs a rewrite. */
  healed: boolean
}

/**
 * The `.memry/properties.md` `properties` map, parsed one entry at a time, or
 * null when the map itself is not an object. An entry that fails the schema is
 * kept verbatim in `unparsed` so one bad or newer definition never costs the
 * vault the rest. A `relation` entry is dropped instead (`healed`): older
 * builds wrote synced relations here, and older builds reject the whole file
 * on one. Desktop and the CLI both rewrite the file through this parser.
 */
export function parsePropertyDefinitionEntries(
  properties: unknown
): ParsedPropertyDefinitionEntries | null {
  const result: ParsedPropertyDefinitionEntries = {
    valid: {},
    unparsed: new Map(),
    healed: false
  }
  if (properties === undefined || properties === null) return result
  if (typeof properties !== 'object' || Array.isArray(properties)) return null
  for (const [name, entry] of Object.entries(properties)) {
    const type = (entry as { type?: PropertyType } | null)?.type
    if (type && !isPersistableDefinitionType(type)) {
      result.healed = true
      continue
    }
    const parsed = PropertyDefinitionSchema.safeParse(entry)
    if (parsed.success) result.valid[name] = parsed.data
    else result.unparsed.set(name, entry)
  }
  return result
}
