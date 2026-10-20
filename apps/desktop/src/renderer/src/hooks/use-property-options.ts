import { useQuery } from '@tanstack/react-query'
import {
  STATUS_CATEGORY_KEYS,
  parseStatusCategories,
  type SelectOption,
  type StatusCategories
} from '@memry/contracts/property-types'
import { notesService, type PropertyDefinition } from '@/services/notes-service'

const PROPERTY_DEFINITIONS_KEY = ['property-definitions'] as const

/** Long enough that a table of cells shares one read, short enough that a colour edit shows soon. */
const STALE_MS = 15_000

export interface PropertyOptions {
  /** The options of a select or multiselect property, in the order the definition lists them. */
  options: SelectOption[]
  /** The categories of a status property, the stock ones when the definition has none. */
  categories: StatusCategories
  /** Every option a status property offers, flattened across its categories. */
  statusOptions: SelectOption[]
}

function parseOptions(definition: PropertyDefinition | undefined): SelectOption[] {
  if (!definition?.options) return []
  try {
    const parsed: unknown = JSON.parse(definition.options)
    return Array.isArray(parsed) ? (parsed as SelectOption[]) : []
  } catch {
    return []
  }
}

/**
 * The options a property offers, for rendering its value as the coloured pill
 * the note panel shows. One shared query serves every cell of a table, so a
 * folder view of a thousand notes reads the definitions once.
 */
export function usePropertyOptions(name: string | undefined): PropertyOptions {
  const { data } = useQuery({
    queryKey: PROPERTY_DEFINITIONS_KEY,
    queryFn: () => notesService.getPropertyDefinitions(),
    staleTime: STALE_MS
  })
  const definition = name ? data?.find((candidate) => candidate.name === name) : undefined
  const categories = parseStatusCategories(definition?.options)
  return {
    options: parseOptions(definition),
    categories,
    statusOptions: STATUS_CATEGORY_KEYS.flatMap((key) => categories[key].options)
  }
}
