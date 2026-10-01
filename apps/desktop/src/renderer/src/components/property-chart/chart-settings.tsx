import { useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  VIEW_BLOCK_CHART_AGGREGATES,
  VIEW_BLOCK_CHART_MISSING,
  VIEW_BLOCK_CHART_RANGES,
  type ViewBlockChart,
  type ViewBlockChartType
} from '@memry/shared/view-block'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Check, ChevronDown, SlidersHorizontal } from '@/lib/icons'
import {
  allowedChartTypes,
  defaultRangeDays,
  resolveChartType,
  suggestedChartType,
  valueKindFor
} from '@/lib/property-chart/chart-model'
import { cn } from '@/lib/utils'
import type { ChartPropertyOption } from './use-chart-data'

/** A change to the chart settings; a key set to undefined goes back to its default. */
export type ChartPatch = Partial<Record<keyof ViewBlockChart, unknown>>

/** The chart settings with a patch applied; a key patched to undefined is dropped. */
export function patchChart(chart: ViewBlockChart | undefined, patch: ChartPatch): ViewBlockChart {
  const next: Record<string, unknown> = { ...chart, ...patch }
  for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key]
  return next as ViewBlockChart
}

const TYPE_LABEL_KEYS: Record<ViewBlockChartType, string> = {
  line: 'editor.chart.types.line',
  bar: 'editor.chart.types.bar',
  heatmap: 'editor.chart.types.heatmap'
}

/** Property types a chart can place a note on a day by. */
const DATE_TYPES = new Set(['date'])

function SettingSelect<T extends string | number>({
  label,
  value,
  options,
  onChange,
  testId
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  testId: string
}): React.JSX.Element {
  const current = options.find((option) => option.value === value)
  return (
    <div className="flex h-8 items-center">
      <span className="w-36 shrink-0 text-[13px] text-muted-foreground">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid={testId}
            className="inline-flex h-7 min-w-0 items-center gap-1 rounded-md px-1.5 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <span className="truncate">{current?.label ?? String(value)}</span>
            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-72 overflow-y-auto">
          <DropdownMenuRadioGroup
            value={String(value)}
            onValueChange={(next) => {
              const picked = options.find((option) => String(option.value) === next)
              if (picked) onChange(picked.value)
            }}
          >
            {options.map((option) => (
              <DropdownMenuRadioItem key={String(option.value)} value={String(option.value)}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function Section({
  label,
  children,
  bordered = true
}: {
  label?: string
  children: React.ReactNode
  bordered?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-2 px-3.5 py-2.5', bordered && 'border-t border-border')}>
      {label ? (
        <div className="text-[11px] font-medium uppercase tracking-[0.04em] text-text-tertiary">
          {label}
        </div>
      ) : null}
      {children}
    </div>
  )
}

export interface ChartSettingsProps {
  chart: ViewBlockChart
  properties: ChartPropertyOption[]
  /** Offer "Date from": the source is not the journal. */
  needsDateFrom: boolean
  onChange: (patch: ChartPatch) => void
  defaultOpen?: boolean
  disabled?: boolean
  /** A source picker shown above the property list, where the host has no header of its own. */
  sourceSlot?: React.ReactNode
}

/**
 * The chart's settings, one popover off the block header. The property and
 * the chart type are the choices that matter; everything under them has a
 * default the property's type suggests.
 */
export function ChartSettings({
  chart,
  properties,
  needsDateFrom,
  onChange,
  defaultOpen = false,
  disabled = false,
  sourceSlot
}: ChartSettingsProps): React.JSX.Element {
  const { t } = useT('notes')
  const [open, setOpen] = useState(defaultOpen)
  const selected = properties.find((p) => p.name === chart.property)
  const kind = valueKindFor(selected?.type)
  const type = resolveChartType(kind, chart.type)
  const suggested = suggestedChartType(kind)
  const rangeDays = chart.rangeDays ?? defaultRangeDays(type)

  const typeLabel = (propertyType: string): string =>
    t(`editor.chart.propertyTypes.${propertyType}`, { defaultValue: propertyType })

  const ranges = [...new Set<number>([...VIEW_BLOCK_CHART_RANGES, rangeDays])]
    .sort((a, b) => a - b)
    .map((days) => ({ value: days, label: t('editor.chart.lastDays', { count: days }) }))

  const dateProperties = properties.filter((p) => DATE_TYPES.has(p.type))
  const dateFromOptions = [
    { value: 'created', label: t('editor.chart.dateFrom.created') },
    { value: 'modified', label: t('editor.chart.dateFrom.modified') },
    ...dateProperties.map((p) => ({ value: p.name, label: p.name }))
  ]

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild disabled={disabled}>
        <button
          type="button"
          data-testid="chart-settings-trigger"
          aria-label={t('editor.chart.settings')}
          className="inline-flex h-7 min-w-0 max-w-[240px] items-center gap-1.5 rounded-md px-1.5 text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
        >
          <SlidersHorizontal
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className={cn('truncate', !chart.property && 'text-muted-foreground')}>
            {chart.property ?? t('editor.chart.chooseProperty')}
          </span>
          {chart.property ? (
            <span className="truncate text-xs text-text-tertiary">
              {t('editor.chart.headerMeta', {
                range: t('editor.chart.lastDays', { count: rangeDays }),
                type: t(TYPE_LABEL_KEYS[type])
              })}
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[340px] p-0 py-1.5" data-testid="chart-settings">
        {sourceSlot ? (
          <Section label={t('editor.chart.source')} bordered={false}>
            {sourceSlot}
          </Section>
        ) : null}
        <Section label={t('editor.chart.property')} bordered={Boolean(sourceSlot)}>
          {properties.length === 0 ? (
            <p className="py-1 text-[13px] text-text-tertiary">{t('editor.chart.noProperties')}</p>
          ) : (
            <div
              role="listbox"
              aria-label={t('editor.chart.property')}
              className="flex max-h-56 flex-col gap-px overflow-y-auto"
            >
              {properties.map((property) => {
                const isSelected = property.name === chart.property
                return (
                  <button
                    key={property.name}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() =>
                      // A new property brings its own suggested chart.
                      onChange({ property: property.name, type: undefined, rangeDays: undefined })
                    }
                    className={cn(
                      'flex h-8 items-center gap-2 rounded-[5px] px-2 text-start text-[13px] text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                      isSelected && 'bg-muted'
                    )}
                  >
                    <span className="min-w-0 grow truncate">{property.name}</span>
                    <span className="w-20 shrink-0 truncate text-xs text-text-tertiary">
                      {typeLabel(property.type)}
                    </span>
                    <span className="flex w-4 shrink-0">
                      {isSelected ? <Check className="size-3.5" aria-hidden="true" /> : null}
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </Section>
        {selected ? (
          <>
            <Section label={t('editor.chart.chartType')}>
              <div
                role="radiogroup"
                aria-label={t('editor.chart.chartType')}
                className="flex flex-wrap gap-1.5"
              >
                {allowedChartTypes(kind).map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={option === type}
                    onClick={() =>
                      onChange({
                        type: option === suggested ? undefined : option,
                        rangeDays: undefined
                      })
                    }
                    className={cn(
                      'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
                      option === type
                        ? 'border-foreground font-medium text-foreground'
                        : 'border-border text-muted-foreground hover:text-foreground'
                    )}
                  >
                    {t(TYPE_LABEL_KEYS[option])}
                    {option === suggested ? (
                      <span className="rounded bg-tint-lighter px-1 text-[10px] font-medium text-foreground">
                        {t('editor.chart.suggested')}
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </Section>
            <Section>
              <SettingSelect
                label={t('editor.chart.range')}
                value={rangeDays}
                options={ranges}
                onChange={(days) =>
                  onChange({ rangeDays: days === defaultRangeDays(type) ? undefined : days })
                }
                testId="chart-range"
              />
              {kind === 'number' ? (
                <SettingSelect
                  label={t('editor.chart.sameDay')}
                  value={chart.aggregate ?? 'average'}
                  options={VIEW_BLOCK_CHART_AGGREGATES.map((value) => ({
                    value,
                    label: t(`editor.chart.aggregates.${value}`)
                  }))}
                  onChange={(value) =>
                    onChange({ aggregate: value === 'average' ? undefined : value })
                  }
                  testId="chart-aggregate"
                />
              ) : null}
              {kind === 'number' && type !== 'heatmap' ? (
                <SettingSelect
                  label={t('editor.chart.missingDays')}
                  value={chart.missing ?? 'gap'}
                  options={VIEW_BLOCK_CHART_MISSING.map((value) => ({
                    value,
                    label: t(`editor.chart.missing.${value}`)
                  }))}
                  onChange={(value) => onChange({ missing: value === 'gap' ? undefined : value })}
                  testId="chart-missing"
                />
              ) : null}
              {needsDateFrom ? (
                <SettingSelect
                  label={t('editor.chart.dateFrom.label')}
                  value={chart.dateFrom ?? 'created'}
                  options={dateFromOptions}
                  onChange={(value) =>
                    onChange({ dateFrom: value === 'created' ? undefined : value })
                  }
                  testId="chart-date-from"
                />
              ) : null}
            </Section>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
