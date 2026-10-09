import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { SelectOption } from '@memry/contracts/property-types'
import { isReservedFieldName, type FieldType } from '@memry/contracts/tag-schema'
import { notesService } from '@/services/notes-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('TagSettings:VaultProperties')

export interface VaultProperty {
  name: string
  type: FieldType
  options: SelectOption[]
  /** Notes in the vault with a value. */
  usage: number
}

/**
 * Every property key the vault knows: the vault-wide definitions (type and
 * options) joined with usage counts over all notes (the vault-root folder
 * scope). Reserved keys are never fields.
 */
export function useVaultProperties(enabled: boolean): VaultProperty[] {
  const query = useQuery({
    queryKey: ['tags', 'settings', 'vault-properties'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<VaultProperty[]> => {
      const [definitions, available] = await Promise.all([
        notesService.getPropertyDefinitions(),
        window.api.folderView.getAvailableProperties({ kind: 'folder', path: '' })
      ])
      const usage = new Map(available.properties.map((p) => [p.name, p]))
      const byName = new Map<string, VaultProperty>()
      for (const definition of definitions) {
        byName.set(definition.name, {
          name: definition.name,
          type: toFieldType(definition.type),
          options: parseOptions(definition.options),
          usage: usage.get(definition.name)?.usageCount ?? 0
        })
      }
      for (const property of available.properties) {
        if (byName.has(property.name)) continue
        byName.set(property.name, {
          name: property.name,
          type: toFieldType(property.type),
          options: [],
          usage: property.usageCount
        })
      }
      return [...byName.values()]
        .filter((property) => !isReservedFieldName(property.name))
        .sort((a, b) => b.usage - a.usage)
    }
  })
  useEffect(() => {
    if (query.error) log.error('Failed to load vault properties', query.error)
  }, [query.error])
  return query.data ?? EMPTY
}

const EMPTY: VaultProperty[] = []

/** `rating` is a legacy definition type with no field type; it reads as a number. */
function toFieldType(type: string): FieldType {
  return type === 'rating' ? 'number' : (type as FieldType)
}

/** Definition options are stored as JSON: SelectOption objects or bare strings. */
function parseOptions(raw: string | null): SelectOption[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item: unknown): SelectOption[] => {
      if (typeof item === 'string') return [{ value: item, color: 'stone' }]
      if (typeof item === 'object' && item !== null && 'value' in item) {
        const value = (item as { value: unknown }).value
        const color = (item as { color?: unknown }).color
        return typeof value === 'string'
          ? [{ value, color: typeof color === 'string' ? color : 'stone' }]
          : []
      }
      return []
    })
  } catch (err) {
    log.warn('Unreadable property options', err)
    return []
  }
}
