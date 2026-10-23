/**
 * The view block over the journal: always a chart, read by day range rather
 * than through the folder view, which has no journal scope.
 */
import { useT } from '@memry/i18n/renderer'
import type { ViewBlockChart } from '@memry/shared/view-block'
import { PropertyChart } from '@/components/property-chart/property-chart'
import { ChartSettings, patchChart } from '@/components/property-chart/chart-settings'
import {
  useJournalChartData,
  useOptionColors,
  useToday,
  type ChartPropertyOption
} from '@/components/property-chart/use-chart-data'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { defaultRangeDays, type ChartDay, type ChartRow } from '@/lib/property-chart/chart-model'
import {
  OpenSourceButton,
  SourcePicker,
  ViewBlockNotice,
  ViewBlockSkeleton,
  journalPageItem,
  sourcePatch,
  type ViewBlockBodyProps
} from './view-block-parts'

/** The widest default range, so one fetch serves whichever chart type the property picks. */
export const CHART_FETCH_DAYS = Math.max(defaultRangeDays('line'), defaultRangeDays('heatmap'))

/**
 * The chart for a block's rows, or the prompt to pick a property. Shared by
 * every source: the journal hands it entries, a folder or tag its notes.
 */
export function ViewBlockChartArea({
  chart,
  rows,
  properties,
  onOpenDay
}: {
  chart: ViewBlockChart
  rows: ChartRow[]
  properties: ChartPropertyOption[]
  onOpenDay: (day: ChartDay) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const today = useToday()
  const optionColors = useOptionColors(chart.property)
  if (!chart.property) return <ViewBlockNotice body={t('editor.chart.chooseProperty')} />
  const propertyType = properties.find((p) => p.name === chart.property)?.type
  return (
    <div className="p-3">
      <PropertyChart
        rows={rows}
        property={chart.property}
        propertyType={propertyType}
        optionColors={optionColors}
        chart={chart}
        today={today}
        onOpenDay={onOpenDay}
      />
    </div>
  )
}

/**
 * A chart over the journal. The journal is not a folder view scope, so this
 * reads entries by day range instead of through `useFolderView`, and has no
 * list layouts, saved views or filters to offer.
 */
export function JournalChartBody(props: ViewBlockBodyProps): React.JSX.Element {
  const { definition, editable, onChange, sourceMenuOpen, chartSettingsOpen } = props
  const { t } = useT('notes')
  const { openSidebarItem } = useSidebarNavigation()
  const today = useToday()
  const chart = definition.chart ?? {}
  const data = useJournalChartData(today, chart.rangeDays ?? CHART_FETCH_DAYS)

  let body: React.ReactNode
  if (data.error) {
    body = <ViewBlockNotice body={t('editor.chart.loadFailed')} destructive />
  } else if (data.isLoading) {
    body = <ViewBlockSkeleton />
  } else {
    body = (
      <ViewBlockChartArea
        chart={chart}
        rows={data.rows}
        properties={data.properties}
        onOpenDay={(day) =>
          openSidebarItem(journalPageItem(t('editor.chart.sourceJournal'), day.day))
        }
      />
    )
  }

  return (
    <>
      <div className="flex min-w-0 flex-wrap items-center gap-1 pb-1.5">
        <SourcePicker
          source={definition.source}
          disabled={!editable}
          defaultOpen={sourceMenuOpen}
          onChange={(source) => onChange(sourcePatch(source))}
        />
        <ChartSettings
          chart={chart}
          properties={data.properties}
          needsDateFrom={false}
          disabled={!editable}
          defaultOpen={chartSettingsOpen}
          onChange={(patch) => onChange({ chart: patchChart(definition.chart, patch) })}
        />
        <div className="grow" />
        <OpenSourceButton definition={definition} />
      </div>
      <div
        className="overflow-hidden rounded-lg border border-border"
        data-view-block-layout="chart"
      >
        {body}
      </div>
    </>
  )
}
