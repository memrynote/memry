/**
 * Layout Toggle
 *
 * Header segmented control for the active view's layout (table / list /
 * gallery). Writes straight into the active view config, so "New view" in the
 * view switcher — which copies the active view — saves the chosen layout along
 * with the current filters and sort.
 */

import { Rows2, List, LayoutGrid } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { ViewConfig } from '@/hooks/use-folder-view'

type ViewType = ViewConfig['type']

const LAYOUT_OPTIONS: { type: ViewType; icon: typeof Rows2; labelKey: string }[] = [
  { type: 'table', icon: Rows2, labelKey: 'phaseF.componentsFolderViewViewSwitcher.table' },
  { type: 'list', icon: List, labelKey: 'phaseF.componentsFolderViewViewSwitcher.list' },
  { type: 'grid', icon: LayoutGrid, labelKey: 'phaseF.componentsFolderViewViewSwitcher.gallery' }
]

interface LayoutToggleProps {
  value: ViewType
  onChange: (type: ViewType) => void
  className?: string
}

export function LayoutToggle({ value, onChange, className }: LayoutToggleProps): React.JSX.Element {
  const { t } = useT('notes')

  return (
    <div
      role="group"
      aria-label={t('phaseF.componentsFolderViewViewSwitcher.layout')}
      className={cn('flex h-8 items-center gap-0.5 rounded-md bg-muted p-0.5', className)}
    >
      {LAYOUT_OPTIONS.map((opt) => {
        const Icon = opt.icon
        const selected = value === opt.type
        const label = t(opt.labelKey)
        return (
          <button
            key={opt.type}
            type="button"
            onClick={() => {
              if (!selected) onChange(opt.type)
            }}
            aria-pressed={selected}
            aria-label={label}
            title={label}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-[5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
              selected
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            <Icon className="size-3.5" />
          </button>
        )
      })}
    </div>
  )
}

export default LayoutToggle
