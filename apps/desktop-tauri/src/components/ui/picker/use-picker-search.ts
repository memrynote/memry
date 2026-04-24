import { useMemo } from 'react'

export function usePickerSearch<T>(items: T[], searchFields: (keyof T)[], query: string): T[] {
  return useMemo(() => {
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return items

    return items.filter((item) =>
      searchFields.some((field) => {
        const val = item[field]
        return typeof val === 'string' && val.toLowerCase().includes(trimmed)
      })
    )
  }, [items, searchFields, query])
}
