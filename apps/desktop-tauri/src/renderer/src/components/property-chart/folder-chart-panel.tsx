import { useMemo } from 'react'
import { useT } from '@memry/i18n/renderer'
import type { ViewBlockChart } from '@memry/shared/view-block'
import type { NoteWithProperties } from '@memry/contracts/folder-view-api'
import { ChartSettings, type ChartPatch } from './chart-settings'
import { PropertyChart } from './property-chart'
import { notesToChartRows, useOptionColors, useToday } from './use-chart-data'

/**
 * The folder or tag page's chart layout: the active view's notes, filtered as
 * the view filters them, plotted on the day `dateFrom` names.
 */
export function FolderChartPanel({
  notes,
  availableProperties,
  chart,
  onChange,
  onOpenNote
}: {
  notes: NoteWithProperties[]
  availableProperties: { name: string; type: string }[]
  chart: ViewBlockChart
  onChange: (patch: ChartPatch) => void
  onOpenNote: (id: string) => void
}): React.JSX.Element {
  const { t } = useT('notes')
  const today = useToday()
  const optionColors = useOptionColors(chart.property)
  const rows = useMemo(
    () => notesToChartRows(notes, chart.dateFrom ?? 'created'),
    [notes, chart.dateFrom]
  )
  const properties = useMemo(
    () => availableProperties.map((p) => ({ name: p.name, type: p.type })),
    [availableProperties]
  )
  const propertyType = properties.find((p) => p.name === chart.property)?.type

  return (
    <div className="h-full overflow-y-auto" data-testid="folder-chart">
      <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-5">
        <div className="flex items-center">
          <ChartSettings
            chart={chart}
            properties={properties}
            needsDateFrom
            defaultOpen={!chart.property}
            onChange={onChange}
          />
        </div>
        {chart.property ? (
          <PropertyChart
            rows={rows}
            property={chart.property}
            propertyType={propertyType}
            optionColors={optionColors}
            chart={chart}
            today={today}
            onOpenDay={(day) => {
              if (day.rowIds[0]) onOpenNote(day.rowIds[0])
            }}
          />
        ) : (
          <p className="py-10 text-center text-sm text-text-tertiary">
            {t('editor.chart.chooseProperty')}
          </p>
        )}
      </div>
    </div>
  )
}
