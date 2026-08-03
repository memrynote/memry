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
  showOnCalendar?: boolean
}

export const DEFAULT_STATUS_DEFINITION: PropertyDefinition = {
  name: 'status',
  type: PropertyTypes.STATUS,
  categories: {
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
}

const SelectOptionSchema = z.object({
  value: z.string().min(1),
  color: z.string().min(1),
  default: z.boolean().optional()
})

const StatusCategorySchema = z.object({
  label: z.string().min(1),
  options: z.array(SelectOptionSchema)
})

const StatusPropertySchema = z.object({
  type: z.literal('status'),
  categories: z.object({
    todo: StatusCategorySchema,
    in_progress: StatusCategorySchema,
    done: StatusCategorySchema
  })
})

const SelectPropertySchema = z.object({
  type: z.literal('select'),
  options: z.array(SelectOptionSchema)
})

const MultiselectPropertySchema = z.object({
  type: z.literal('multiselect'),
  options: z.array(SelectOptionSchema)
})

const DatePropertySchema = z.object({
  type: z.literal('date'),
  showOnCalendar: z.boolean().optional()
})

const ProjectPropertySchema = z.object({
  type: z.literal('project')
})

export const PropertyDefinitionSchema = z.discriminatedUnion('type', [
  StatusPropertySchema,
  SelectPropertySchema,
  MultiselectPropertySchema,
  DatePropertySchema,
  ProjectPropertySchema
])

export const PropertyDefinitionsFileSchema = z.object({
  properties: z.record(z.string(), PropertyDefinitionSchema).default({})
})

export type PropertyDefinitionsFileData = z.infer<typeof PropertyDefinitionsFileSchema>
