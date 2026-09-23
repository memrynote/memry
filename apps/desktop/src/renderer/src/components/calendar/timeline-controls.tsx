import { useT } from '@memry/i18n/renderer'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SlidersHorizontal } from '@/lib/icons'
import { cn } from '@/lib/utils'
import {
  TIMELINE_GROUP_BYS,
  TIMELINE_ORDER_BYS,
  TIMELINE_ZOOMS,
  type TimelineGroupBy,
  type TimelineSettings,
  type TimelineZoom
} from './timeline-model'

type SettingsUpdate = (
  next: TimelineSettings | ((previous: TimelineSettings) => TimelineSettings)
) => void

interface ZoomSegmentsProps {
  zoom: TimelineZoom
  onChange: (zoom: TimelineZoom) => void
  variant: 'toolbar' | 'panel'
}

function ZoomSegments({ zoom, onChange, variant }: ZoomSegmentsProps): React.JSX.Element {
  const { t } = useT('calendar')
  return (
    <div
      role="radiogroup"
      aria-label={t('timeline.zoom.label')}
      className={cn(
        'flex shrink-0 items-center',
        variant === 'toolbar' ? 'gap-0.5' : 'gap-0.5 rounded-lg bg-surface-active/70 p-0.5'
      )}
    >
      {TIMELINE_ZOOMS.map((option) => {
        const isActive = option === zoom
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(option)}
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors duration-100 ease-out',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
              variant === 'panel' && 'flex-1',
              isActive
                ? variant === 'toolbar'
                  ? 'bg-surface-active text-foreground'
                  : 'bg-background text-foreground shadow-sm'
                : 'text-text-tertiary hover:text-foreground'
            )}
          >
            {t(`timeline.zoom.${option}`)}
          </button>
        )
      })}
    </div>
  )
}

export function TimelineZoomControl({
  zoom,
  onChange
}: {
  zoom: TimelineZoom
  onChange: (zoom: TimelineZoom) => void
}): React.JSX.Element {
  // Hidden on narrow panes: the Display popover carries the same control.
  return (
    <div className="hidden @3xl:block">
      <ZoomSegments zoom={zoom} onChange={onChange} variant="toolbar" />
    </div>
  )
}

/**
 * Grouping picker. In the Display panel it is a filled chip; above the task
 * list it reads as a quiet "By project" label, the way Linear's list header does.
 */
export function TimelineGroupBySelect({
  value,
  onChange,
  variant = 'chip'
}: {
  value: TimelineGroupBy
  onChange: (groupBy: TimelineGroupBy) => void
  variant?: 'chip' | 'header'
}): React.JSX.Element {
  const { t } = useT('calendar')
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const groupBy = TIMELINE_GROUP_BYS.find((option) => option === next)
        if (groupBy) onChange(groupBy)
      }}
    >
      <SelectTrigger
        aria-label={t('timeline.display.group-by')}
        className={cn(
          'h-6 w-auto gap-1 border-0 px-2 text-xs font-medium focus:ring-0 focus-visible:outline-2 focus-visible:outline-ring',
          variant === 'chip'
            ? 'bg-surface-active/70'
            : '-me-2 bg-transparent text-text-tertiary hover:text-foreground [&>svg]:size-3'
        )}
      >
        {variant === 'header' ? (
          <span>{t('timeline.group-by-label', { group: t(`timeline.group-by.${value}`) })}</span>
        ) : (
          <SelectValue />
        )}
      </SelectTrigger>
      <SelectContent align="end">
        {TIMELINE_GROUP_BYS.map((option) => (
          <SelectItem key={option} value={option} className="text-[13px]">
            {t(`timeline.group-by.${option}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

type ToggleKey = 'showEvents' | 'showUndated' | 'showCompleted' | 'showSubtasks'

const TOGGLES: { key: ToggleKey; labelKey: `timeline.display.${string}` }[] = [
  { key: 'showEvents', labelKey: 'timeline.display.show-events' },
  { key: 'showUndated', labelKey: 'timeline.display.show-undated' },
  { key: 'showCompleted', labelKey: 'timeline.display.show-completed' },
  { key: 'showSubtasks', labelKey: 'timeline.display.show-subtasks' }
]

function DisplayRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-8 items-center justify-between gap-3 px-3">
      <span className="text-[13px] text-foreground">{label}</span>
      {children}
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="px-3 pt-2.5 pb-1 text-[11px] font-medium text-text-tertiary">{children}</div>
  )
}

export function TimelineDisplayPopover({
  settings,
  onChange
}: {
  settings: TimelineSettings
  onChange: SettingsUpdate
}): React.JSX.Element {
  const { t } = useT('calendar')
  const patch = (update: Partial<TimelineSettings>): void =>
    onChange((current) => ({ ...current, ...update }))

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-surface-active/80 px-3 text-xs font-medium text-muted-foreground',
            'transition-colors duration-150 ease-out hover:text-foreground active:scale-95',
            'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring'
          )}
        >
          <SlidersHorizontal className="size-3.5" aria-hidden="true" />
          {t('timeline.display.button')}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-1 pb-2">
        <SectionLabel>{t('timeline.zoom.label')}</SectionLabel>
        <div className="px-3 pt-0.5 pb-1.5">
          <ZoomSegments zoom={settings.zoom} onChange={(zoom) => patch({ zoom })} variant="panel" />
        </div>

        <DisplayRow label={t('timeline.display.group-by')}>
          <TimelineGroupBySelect
            value={settings.groupBy}
            onChange={(groupBy) => patch({ groupBy })}
          />
        </DisplayRow>

        <DisplayRow label={t('timeline.display.order-by')}>
          <Select
            value={settings.orderBy}
            onValueChange={(value) => {
              const orderBy = TIMELINE_ORDER_BYS.find((option) => option === value)
              if (orderBy) patch({ orderBy })
            }}
          >
            <SelectTrigger
              aria-label={t('timeline.display.order-by')}
              className="h-6 w-auto gap-1 border-0 bg-surface-active/70 px-2 text-xs font-medium"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {TIMELINE_ORDER_BYS.map((option) => (
                <SelectItem key={option} value={option} className="text-[13px]">
                  {t(`timeline.order-by.${option}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </DisplayRow>

        <div className="my-1 h-px bg-border" />
        <SectionLabel>{t('timeline.display.show')}</SectionLabel>
        {TOGGLES.map(({ key, labelKey }) => (
          <DisplayRow key={key} label={t(labelKey)}>
            <Switch
              aria-label={t(labelKey)}
              checked={settings[key]}
              onCheckedChange={(checked) => patch({ [key]: checked })}
            />
          </DisplayRow>
        ))}
      </PopoverContent>
    </Popover>
  )
}
