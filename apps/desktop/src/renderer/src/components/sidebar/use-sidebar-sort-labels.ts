import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { SidebarSortMode } from '@memry/contracts/sidebar-sort'

const LABEL_KEYS: Record<SidebarSortMode, string> = {
  manual: 'phaseF.componentsAppSidebar.sortModeManual',
  'name-asc': 'phaseF.componentsAppSidebar.sortModeNameAsc',
  'name-desc': 'phaseF.componentsAppSidebar.sortModeNameDesc',
  'modified-desc': 'phaseF.componentsAppSidebar.sortModeModifiedDesc',
  'modified-asc': 'phaseF.componentsAppSidebar.sortModeModifiedAsc',
  'created-desc': 'phaseF.componentsAppSidebar.sortModeCreatedDesc',
  'created-asc': 'phaseF.componentsAppSidebar.sortModeCreatedAsc',
  'count-desc': 'phaseF.componentsAppSidebar.sortModeCountDesc',
  'count-asc': 'phaseF.componentsAppSidebar.sortModeCountAsc'
}

export interface SidebarSortLabels {
  labels: Record<SidebarSortMode, string>
  /** "Sort <section>: <current mode>" for the trigger's accessible name. */
  triggerLabel: (sectionLabel: string, mode: SidebarSortMode) => string
}

export function useSidebarSortLabels(): SidebarSortLabels {
  const { t } = useT('common')

  return useMemo(() => {
    const labels = Object.fromEntries(
      Object.entries(LABEL_KEYS).map(([mode, key]) => [mode, t(key)])
    ) as Record<SidebarSortMode, string>

    return {
      labels,
      triggerLabel: (sectionLabel, mode) =>
        t('phaseF.componentsAppSidebar.sortLabel', { section: sectionLabel, mode: labels[mode] })
    }
  }, [t])
}
