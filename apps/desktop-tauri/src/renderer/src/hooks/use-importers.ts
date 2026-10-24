import { useEffect, useState } from 'react'
import type { ImporterMeta } from '@memry/contracts/import-channels'
import type { AppIcon } from '@/lib/icons/types'
import { IMPORT_ICONS, DEFAULT_IMPORT_ICON } from '@/lib/import-catalog'

export interface ImporterItem extends ImporterMeta {
  icon: AppIcon
}

/** Fetches registered importers from the registry and merges per-id icons. */
export function useImporters(): { importers: ImporterItem[]; isLoading: boolean } {
  const [importers, setImporters] = useState<ImporterItem[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let active = true
    void window.api.import
      .list()
      .then((meta) => {
        if (!active) return
        setImporters(meta.map((m) => ({ ...m, icon: IMPORT_ICONS[m.id] ?? DEFAULT_IMPORT_ICON })))
      })
      .finally(() => {
        if (active) setIsLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  return { importers, isLoading }
}
