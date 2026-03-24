import { useState, useEffect, useMemo } from 'react'
import type { IconSvgElement } from '@hugeicons/react'
import { loadAllIcons } from '@/lib/hugeicon-renderer'

interface IconEntry {
  name: string
  data: IconSvgElement
}

function splitCamelCase(str: string): string {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/(\d+)/g, ' $1 ')
    .replace(/Icon$/, '')
    .toLowerCase()
    .trim()
}

export function useHugeIconPicker(): {
  icons: IconEntry[]
  search: string
  setSearch: (s: string) => void
  isLoading: boolean
} {
  const [allIcons, setAllIcons] = useState<IconEntry[]>([])
  const [search, setSearch] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    loadAllIcons().then((mod) => {
      if (cancelled) return

      const entries: IconEntry[] = []
      for (const key of Object.keys(mod)) {
        if (key.endsWith('Icon') && key[0] === key[0].toUpperCase()) {
          entries.push({ name: key, data: mod[key] as IconSvgElement })
        }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name))
      setAllIcons(entries)
      setIsLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [])

  const icons = useMemo(() => {
    if (!search.trim()) return allIcons
    const q = search.toLowerCase()
    return allIcons.filter((entry) => splitCamelCase(entry.name).includes(q))
  }, [allIcons, search])

  return { icons, search, setSearch, isLoading }
}
