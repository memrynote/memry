/**
 * Layout Toggle
 *
 * Header segmented control for the active view's layout (table / list /
 * gallery). Writes straight into the active view config, so "New view" in the
 * view switcher — which copies the active view — saves the chosen layout along
 * with the current filters and sort.
 *
 * `chart` is offered only where the caller asks for it. A saved view's type is
 * validated by older builds as table/list/gallery, so a chart is never written
 * into `.folder.md`: the folder page keeps it as tab state, the view block in
 * its own definition.
 */

import { Rows2, List, LayoutGrid, TrendingUp } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'
import type { ViewConfig } from '@/hooks/use-folder-view'

export type LayoutType = ViewConfig['type'] | 'chart'

const LAYOUT_OPTIONS: { type: LayoutType; icon: typeof Rows2; labelKey: string }[] = [
  { type: 'table', icon: Rows2, labelKey: 'phaseF.componentsFolderViewViewSwitcher.table' },
  { type: 'list', icon: List, labelKey: 'phaseF.componentsFolderViewViewSwitcher.list' },
  { type: 'grid', icon: LayoutGrid, labelKey: 'phaseF.componentsFolderViewViewSwitcher.gallery' },
  { type: 'chart', icon: TrendingUp, labelKey: 'editor.chart.layout' }
]

interface LayoutToggleProps<T extends LayoutType> {
  value: T
  onChange: (type: T) => void
  /** Offer the chart layout. */
  withChart?: boolean
  className?: string
}

export function LayoutToggle<T extends LayoutType>({
  value,
  onChange,
  withChart = false,
  className
}: LayoutToggleProps<T>): React.JSX.Element {
  const { t } = useT('notes')
  const options = withChart ? LAYOUT_OPTIONS : LAYOUT_OPTIONS.filter((opt) => opt.type !== 'chart')

  return (
    <div
      role="group"
      aria-label={t('phaseF.componentsFolderViewViewSwitcher.layout')}
      className={cn('flex h-8 items-center gap-0.5 rounded-md bg-muted p-0.5', className)}
    >
      {options.map((opt) => {
        const Icon = opt.icon
        const selected = value === opt.type
        const label = t(opt.labelKey)
        return (
          <button
            key={opt.type}
            type="button"
            onClick={() => {
              if (!selected) onChange(opt.type as T)
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
