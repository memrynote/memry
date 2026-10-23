import { useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@memry/i18n/renderer'
import { VIEW_BLOCK_LANGUAGE, serializeViewBlockDefinition } from '@memry/shared/view-block'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { extractErrorMessage } from '@/lib/ipc-error'
import { Copy, TrendingUp } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { PropertyChart } from './property-chart'
import { useJournalChartData, useOptionColors, useToday } from './use-chart-data'

/** Thirteen weeks: a quarter, and a heatmap that fits a popover. */
const HISTORY_DAYS = 91

/**
 * The fence a chart block is on disk. Pasted into a note, the editor reads it
 * as a `memry-view` code block, which is the chart.
 */
function chartBlockMarkdown(property: string): string {
  const definition = serializeViewBlockDefinition({
    source: { kind: 'journal' },
    layout: 'chart',
    chart: { property }
  })
  return `\`\`\`${VIEW_BLOCK_LANGUAGE}\n${definition}\n\`\`\`\n`
}

function HistoryBody({
  property,
  propertyType,
  onDone
}: {
  property: string
  propertyType: string
  onDone: () => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const { openSidebarItem } = useSidebarNavigation()
  const today = useToday()
  const data = useJournalChartData(today, HISTORY_DAYS)
  const optionColors = useOptionColors(property)

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(chartBlockMarkdown(property))
      toast.success(t('editor.chart.history.copied'))
      onDone()
    } catch (err) {
      toast.error(extractErrorMessage(err, t('editor.chart.loadFailed')))
    }
  }

  return (
    <>
      <div className="flex flex-col gap-3 px-4 pb-3 pt-3.5">
        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-[13px] font-semibold text-foreground">
            {t('editor.chart.history.title', { property })}
          </span>
          <span className="shrink-0 text-xs text-text-tertiary">
            {t('editor.chart.history.range')}
          </span>
        </div>
        {data.error ? (
          <p className="text-sm text-destructive">{t('editor.chart.loadFailed')}</p>
        ) : data.isLoading ? (
          <Skeleton className="h-36 w-full" />
        ) : (
          <PropertyChart
            rows={data.rows}
            property={property}
            propertyType={propertyType}
            optionColors={optionColors}
            chart={{ rangeDays: HISTORY_DAYS }}
            today={today}
            compact
            onOpenDay={(day) => {
              openSidebarItem({
                type: 'journal',
                title: t('editor.chart.sourceJournal'),
                icon: 'book-open',
                path: '/journal',
                viewState: { date: day.day }
              })
              onDone()
            }}
          />
        )}
      </div>
      <div className="border-t border-border p-1">
        <button
          type="button"
          onClick={() => void copy()}
          className="flex h-8 w-full items-center gap-2 rounded-[5px] px-2 text-start text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          <Copy className="size-3.5 text-muted-foreground" aria-hidden="true" />
          {t('editor.chart.history.insert')}
        </button>
      </div>
    </>
  )
}

/**
 * A journal property's last thirteen weeks, one click off its row. The button
 * shows while the row is hovered or focused, and while the popover is open.
 */
export function PropertyHistoryButton({
  property,
  propertyType,
  visible
}: {
  property: string
  propertyType: string
  visible: boolean
}): React.JSX.Element {
  const { t } = useT('notes')
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t('editor.chart.history.show')}: ${property}`}
          title={t('editor.chart.history.show')}
          className={cn(
            'ms-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-text-tertiary transition-opacity duration-150 hover:bg-surface hover:text-muted-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
            visible || open ? 'opacity-100' : 'opacity-0'
          )}
        >
          <TrendingUp className="h-3.5 w-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[360px] p-0" data-testid="property-history">
        <HistoryBody
          property={property}
          propertyType={propertyType}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}
