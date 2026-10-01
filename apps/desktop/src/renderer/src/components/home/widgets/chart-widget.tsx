import { useEffect, useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  readViewBlockChart,
  readViewBlockSource,
  viewBlockScope,
  type ViewBlockChart,
  type ViewBlockSource
} from '@memry/shared/view-block'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import type { WidgetComponentProps, WidgetConfigEditorProps } from '@/lib/home/widget-registry'
import type { WidgetSize } from '@/lib/home/types'
import { SourcePicker } from '@/components/note/content-area/view-block-parts'
import { ChartSettings, patchChart } from '@/components/property-chart/chart-settings'
import { PropertyChart } from '@/components/property-chart/property-chart'
import {
  notesToChartRows,
  useJournalChartData,
  useOptionColors,
  useToday,
  type ChartData,
  type ChartPropertyOption
} from '@/components/property-chart/use-chart-data'
import { Skeleton } from '@/components/ui/skeleton'
import { useFolderView } from '@/hooks/use-folder-view'
import { useSidebarNavigation } from '@/hooks/use-sidebar-navigation'
import { sidebarItemForRow } from '@/lib/folder-row-navigation'
import type { ChartDay } from '@/lib/property-chart/chart-model'

/**
 * The Home chart widget: the chart a `/chart` block draws, over the journal, a
 * folder or a tag, set up from its header.
 *
 * Its config is `{ source, chart }` in the view block's own shapes and read with
 * the same tolerant readers, so a board synced from a newer build still draws.
 * The journal and the folder/tag readers are separate components, so only the
 * one the source needs ever queries.
 */

const JOURNAL: ViewBlockSource = { kind: 'journal' }
/** Rows a widget pages through on a folder or tag before it stops asking. */
const MAX_ROWS_SCANNED = 2000
/** One journal fetch covers both default ranges and their previous periods. */
const JOURNAL_FETCH_DAYS = 182

type NotesScope = Exclude<ReturnType<typeof viewBlockScope>, { kind: 'journal' }>

interface ChartWidgetConfig {
  source: ViewBlockSource
  chart: ViewBlockChart
}

function readConfig(config: Record<string, unknown>): ChartWidgetConfig {
  return {
    source: readViewBlockSource(config.source) ?? JOURNAL,
    chart: readViewBlockChart(config.chart) ?? {}
  }
}

function useJournalData(chart: ViewBlockChart): ChartData {
  const today = useToday()
  return useJournalChartData(today, chart.rangeDays ?? JOURNAL_FETCH_DAYS)
}

/** A folder or tag's notes as chart rows, read through the folder view as a view block does. */
function useNotesData(
  scope: NotesScope,
  chart: ViewBlockChart
): ChartData & { notes: NoteWithProperties[] } {
  const view = useFolderView({ scope })
  const { hasMore, unfilteredCount, loadMore } = view
  useEffect(() => {
    if (hasMore && unfilteredCount < MAX_ROWS_SCANNED) void loadMore()
  }, [hasMore, unfilteredCount, loadMore])

  const rows = useMemo(
    () => notesToChartRows(view.notes, chart.dateFrom ?? 'created'),
    [view.notes, chart.dateFrom]
  )
  const properties = useMemo<ChartPropertyOption[]>(
    () => view.availableProperties.map((p) => ({ name: p.name, type: p.type })),
    [view.availableProperties]
  )
  return {
    rows,
    properties,
    notes: view.notes,
    isLoading: view.isLoading,
    error: view.error ? String(view.error) : null
  }
}

function WidgetChartBody({
  data,
  chart,
  size,
  onOpenDay
}: {
  data: ChartData
  chart: ViewBlockChart
  size: WidgetSize
  onOpenDay: (day: ChartDay) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const today = useToday()
  const optionColors = useOptionColors(chart.property)
  if (!chart.property) {
    return <p className="text-sm text-text-tertiary">{t('editor.chart.chooseProperty')}</p>
  }
  if (data.error) {
    return <p className="text-sm text-destructive">{t('editor.chart.loadFailed')}</p>
  }
  if (data.isLoading) return <Skeleton className="h-32 w-full" />
  return (
    <PropertyChart
      rows={data.rows}
      property={chart.property}
      propertyType={data.properties.find((p) => p.name === chart.property)?.type}
      optionColors={optionColors}
      chart={chart}
      today={today}
      compact={size === 'S'}
      onOpenDay={onOpenDay}
    />
  )
}

function JournalChartWidget({
  chart,
  size
}: {
  chart: ViewBlockChart
  size: WidgetSize
}): React.JSX.Element {
  const { t } = useT('notes')
  const { openSidebarItem } = useSidebarNavigation()
  const data = useJournalData(chart)
  return (
    <WidgetChartBody
      data={data}
      chart={chart}
      size={size}
      onOpenDay={(day) =>
        openSidebarItem({
          type: 'journal',
          title: t('editor.chart.sourceJournal'),
          icon: 'book-open',
          path: '/journal',
          viewState: { date: day.day }
        })
      }
    />
  )
}

function NotesChartWidget({
  scope,
  chart,
  size
}: {
  scope: NotesScope
  chart: ViewBlockChart
  size: WidgetSize
}): React.JSX.Element {
  const { openSidebarItem } = useSidebarNavigation()
  const data = useNotesData(scope, chart)
  return (
    <WidgetChartBody
      data={data}
      chart={chart}
      size={size}
      onOpenDay={(day) => {
        const note = data.notes.find((row) => row.id === day.rowIds[0])
        if (note) openSidebarItem(sidebarItemForRow(note), undefined)
      }}
    />
  )
}

export function ChartWidget({ config, size }: WidgetComponentProps): React.JSX.Element {
  const { source, chart } = readConfig(config)
  const scope = viewBlockScope(source)
  if (scope.kind === 'journal') return <JournalChartWidget chart={chart} size={size} />
  return <NotesChartWidget scope={scope} chart={chart} size={size} />
}

function HeaderSettings({
  config,
  settings,
  properties,
  onChange
}: WidgetConfigEditorProps & {
  settings: ChartWidgetConfig
  properties: ChartPropertyOption[]
}): React.JSX.Element {
  return (
    <ChartSettings
      chart={settings.chart}
      properties={properties}
      needsDateFrom={settings.source.kind !== 'journal'}
      defaultOpen={!settings.chart.property}
      onChange={(patch) => onChange({ ...config, chart: patchChart(settings.chart, patch) })}
      sourceSlot={
        <SourcePicker
          source={settings.source}
          disabled={false}
          defaultOpen={false}
          // A new source has its own properties: start the chart over.
          onChange={(source) => onChange({ ...config, source, chart: {} })}
        />
      }
    />
  )
}

function JournalHeader(props: WidgetConfigEditorProps & { settings: ChartWidgetConfig }) {
  const data = useJournalData(props.settings.chart)
  return <HeaderSettings {...props} properties={data.properties} />
}

function NotesHeader(
  props: WidgetConfigEditorProps & { settings: ChartWidgetConfig; scope: NotesScope }
) {
  const data = useNotesData(props.scope, props.settings.chart)
  return <HeaderSettings {...props} properties={data.properties} />
}

/** Header control: the chart settings, with the source picker at their top. */
export function ChartWidgetHeader(props: WidgetConfigEditorProps): React.JSX.Element {
  const settings = readConfig(props.config)
  const scope = viewBlockScope(settings.source)
  if (scope.kind === 'journal') return <JournalHeader {...props} settings={settings} />
  return <NotesHeader {...props} settings={settings} scope={scope} />
}
