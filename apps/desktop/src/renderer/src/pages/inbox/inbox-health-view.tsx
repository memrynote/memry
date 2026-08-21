import { useCallback, useMemo, useRef } from 'react'
import { useT } from '@memry/i18n/renderer'
import {
  ArrowRight,
  Link2,
  Mic,
  StickyNote,
  Paperclip,
  Image,
  MessageCircle,
  File,
  Bell,
  HelpCircle,
  CheckCircle
} from '@/lib/icons'
import type { AppIcon } from '@/lib/icons'
import type { InboxCapturePattern, InboxFilingHistoryEntry } from '@memry/rpc/inbox'
import { useInboxStats, useInboxFilingHistory, useInboxPatterns } from '@/hooks/use-inbox'
import { cn } from '@/lib/utils'
import { useTabScrollRestore } from '@/hooks/use-tab-scroll-restore'
import { INBOX_SCROLL_KEYS } from './inbox-view-state'

export interface InboxHealthViewProps {
  className?: string
}

const HEATMAP_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22] as const
const MONDAY_UTC = Date.UTC(2024, 0, 1)

const TYPE_ICONS: Record<string, AppIcon> = {
  link: Link2,
  voice: Mic,
  note: StickyNote,
  clip: Paperclip,
  image: Image,
  social: MessageCircle,
  pdf: File,
  reminder: Bell
}

const TYPE_BAR_COLORS: Record<string, string> = {
  link: 'bg-indigo-500 dark:bg-indigo-400',
  voice: 'bg-accent-orange',
  note: 'bg-muted-foreground/60',
  clip: 'bg-accent-purple',
  image: 'bg-accent-green',
  social: 'bg-accent-cyan',
  pdf: 'bg-rose-500 dark:bg-rose-400',
  reminder: 'bg-amber-500 dark:bg-amber-400'
}

const TYPE_ICON_COLORS: Record<string, string> = {
  link: 'text-indigo-500 dark:text-indigo-400',
  voice: 'text-accent-orange',
  note: 'text-muted-foreground',
  clip: 'text-accent-purple',
  image: 'text-accent-green',
  social: 'text-accent-cyan',
  pdf: 'text-rose-500 dark:text-rose-400',
  reminder: 'text-amber-500 dark:text-amber-400'
}

function formatAvgTime(minutes: number): string {
  if (minutes <= 0) return '—'
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)}h`
  return `${(minutes / 1440).toFixed(1)}d`
}

type RelativeTimeParts =
  | { kind: 'now' }
  | { kind: 'minutes'; count: number }
  | { kind: 'hours'; count: number }
  | { kind: 'days'; count: number }

function timeAgoParts(date: Date): RelativeTimeParts {
  const ms = Date.now() - date.getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return { kind: 'now' }
  if (mins < 60) return { kind: 'minutes', count: mins }
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return { kind: 'hours', count: hrs }
  const days = Math.floor(hrs / 24)
  return { kind: 'days', count: days }
}

type PeakInfo = { hasCaptures: false } | { hasCaptures: true; peakDay: number; peakHour: number }

function computePeakInfo(heatmap: number[][]): PeakInfo {
  let maxVal = 0
  let peakHour = 0
  let peakDay = 0

  heatmap.forEach((hourRow, hour) => {
    hourRow.forEach((count, day) => {
      if (count > maxVal) {
        maxVal = count
        peakHour = hour
        peakDay = day
      }
    })
  })

  if (maxVal === 0) return { hasCaptures: false }

  return { hasCaptures: true, peakDay, peakHour }
}

function getWeekdayNames(locale: string, weekday: 'short' | 'long'): string[] {
  const formatter = new Intl.DateTimeFormat(locale, { weekday, timeZone: 'UTC' })
  return Array.from({ length: 7 }, (_, day) =>
    formatter.format(new Date(MONDAY_UTC + day * 24 * 60 * 60 * 1000))
  )
}

function formatPeakHour(hour: number, locale: string): string {
  const formatter = new Intl.DateTimeFormat(locale, {
    hour: 'numeric',
    timeZone: 'UTC'
  })
  return formatter.format(new Date(Date.UTC(2024, 0, 1, hour % 24)))
}

// ---------------------------------------------------------------------------
// Stat Card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
  subValue,
  subColor = 'text-text-tertiary',
  borderColor = 'border-border/50'
}: {
  label: string
  value: string | number
  subValue: string
  subColor?: string
  borderColor?: string
}): React.JSX.Element {
  return (
    <div
      className={cn('flex flex-col grow basis-0 rounded-[10px] gap-1.5 border p-4', borderColor)}
    >
      <div className="uppercase tracking-[0.04em] text-text-tertiary font-sans text-[11px]/3.5">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-foreground font-sans font-semibold text-[28px]/8 tabular-nums">
          {value}
        </span>
        {subValue && <span className={cn('font-sans text-[11px]/3.5', subColor)}>{subValue}</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Capture Heatmap
// ---------------------------------------------------------------------------

function intensityToAlpha(intensity: number): string {
  if (intensity <= 0) return '0D'
  if (intensity < 0.1) return '1A'
  if (intensity < 0.2) return '26'
  if (intensity < 0.3) return '40'
  if (intensity < 0.4) return '59'
  if (intensity < 0.5) return '73'
  if (intensity < 0.6) return '8C'
  if (intensity < 0.7) return '99'
  if (intensity < 0.8) return 'B3'
  if (intensity < 0.9) return 'CC'
  return 'E6'
}

function CaptureHeatmap({
  patterns
}: {
  patterns: InboxCapturePattern | undefined
}): React.JSX.Element {
  const { t, i18n } = useT('inbox')
  const heatmap = patterns?.timeHeatmap
  const hasData = Array.isArray(heatmap) && heatmap.length > 0
  const dayNames = useMemo(() => getWeekdayNames(i18n.language, 'short'), [i18n.language])

  const { maxCount, peakText } = useMemo(() => {
    if (!hasData) return { maxCount: 0, peakText: t('insights.noCapturesYet') }

    let max = 0
    for (let day = 0; day < 7; day++) {
      for (const hour of HEATMAP_HOURS) {
        const val = (heatmap[hour]?.[day] ?? 0) + (heatmap[hour + 1]?.[day] ?? 0)
        if (val > max) max = val
      }
    }

    const peakInfo = computePeakInfo(heatmap)
    if (!peakInfo.hasCaptures) {
      return { maxCount: max, peakText: t('insights.noCapturesYet') }
    }

    const longDayNames = getWeekdayNames(i18n.language, 'long')
    return {
      maxCount: max,
      peakText: t('insights.peak', {
        day: longDayNames[peakInfo.peakDay],
        start: formatPeakHour(peakInfo.peakHour, i18n.language),
        end: formatPeakHour(Math.min(peakInfo.peakHour + 2, 24), i18n.language)
      })
    }
  }, [heatmap, hasData, i18n.language, t])

  return (
    <div className="flex flex-col grow basis-0 rounded-[10px] gap-3.5 border border-border/50 p-4">
      <div className="text-muted-foreground font-sans font-medium text-xs/4">
        {t('insights.captureActivity')}
      </div>
      <div className="[font-synthesis:none] flex gap-1.5 text-xs/4">
        <div className="flex flex-col pt-4 gap-0.75">
          {dayNames.map((day) => (
            <div
              key={day}
              className="h-3 inline-block text-[#50505A] font-sans shrink-0 text-[9px]/3"
            >
              {day}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-0.75">
          <div className="flex h-3 gap-0.75 shrink-0">
            {HEATMAP_HOURS.map((hour) => (
              <div
                key={hour}
                className="w-3 text-center inline-block text-[#50505A] font-sans shrink-0 text-[9px]/3"
              >
                {hour}
              </div>
            ))}
          </div>
          {dayNames.map((_, dayIdx) => (
            <div key={dayIdx} className="flex gap-0.75">
              {HEATMAP_HOURS.map((hour) => {
                const val = (heatmap?.[hour]?.[dayIdx] ?? 0) + (heatmap?.[hour + 1]?.[dayIdx] ?? 0)
                const intensity = maxCount > 0 ? val / maxCount : 0
                return (
                  <div
                    key={hour}
                    className="rounded-xs shrink-0 size-3"
                    style={{ backgroundColor: `#E8A44A${intensityToAlpha(intensity)}` }}
                    title={t('insights.captures', { count: val })}
                  />
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="text-text-tertiary font-sans text-[10px]/3.5">{peakText}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Type Distribution
// ---------------------------------------------------------------------------

function TypeDistribution({
  itemsByType
}: {
  itemsByType: Record<string, number>
}): React.JSX.Element {
  const { t } = useT('inbox')
  const sortedTypes = useMemo(
    () =>
      Object.entries(itemsByType)
        .filter(([, count]) => count > 0)
        .sort(([, a], [, b]) => b - a),
    [itemsByType]
  )

  const maxCount = sortedTypes.length > 0 ? sortedTypes[0][1] : 0

  if (sortedTypes.length === 0) {
    return (
      <div className="flex flex-col grow basis-0 rounded-[10px] border border-border/50 p-4 items-center justify-center min-h-[180px]">
        <span className="text-muted-foreground font-serif text-sm italic">
          {t('empty.noItemsYet')}
        </span>
      </div>
    )
  }

  const typeLabels: Record<string, string> = {
    link: t('type.link'),
    note: t('type.note'),
    image: t('type.image'),
    voice: t('type.voice'),
    video: t('type.video'),
    clip: t('type.clip'),
    pdf: t('type.pdf'),
    social: t('type.social'),
    reminder: t('type.reminder')
  }

  return (
    <div className="flex flex-col grow basis-0 rounded-[10px] gap-3.5 border border-border/50 p-4">
      <div className="text-muted-foreground font-sans font-medium text-xs/4">
        {t('insights.byType')}
      </div>
      <div className="flex flex-col gap-2.5">
        {sortedTypes.map(([type, count]) => {
          const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
          const barColor = TYPE_BAR_COLORS[type] ?? 'bg-muted-foreground/40'
          const label = typeLabels[type] ?? type.charAt(0).toUpperCase() + type.slice(1)

          return (
            <div key={type} className="flex items-center gap-2.5">
              <div className="w-[50px] shrink-0 text-muted-foreground font-sans text-[11px]/3.5">
                {label}
              </div>
              <div className="flex grow h-2 rounded-sm overflow-clip bg-muted/30">
                <div
                  className={cn('h-2 rounded-sm transition-all duration-500 ease-out', barColor)}
                  style={{ width: `${Math.max(pct, 4)}%` }}
                />
              </div>
              <div className="w-5 shrink-0 text-end text-text-tertiary font-sans text-[11px]/3.5 tabular-nums">
                {count}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Filing Row
// ---------------------------------------------------------------------------

function FilingRow({ item }: { item: InboxFilingHistoryEntry }): React.JSX.Element {
  const { t } = useT('inbox')
  const isLinked = item.filedAction === 'linked'
  const Icon = isLinked ? CheckCircle : (TYPE_ICONS[item.itemType] ?? HelpCircle)
  const iconColor = isLinked
    ? 'text-indigo-500 dark:text-indigo-400'
    : (TYPE_ICON_COLORS[item.itemType] ?? 'text-muted-foreground')
  const relativeTime = timeAgoParts(new Date(item.filedAt))
  const relativeText =
    relativeTime.kind === 'now'
      ? t('insights.now')
      : relativeTime.kind === 'minutes'
        ? t('insights.timeAgoMinutes', { count: relativeTime.count })
        : relativeTime.kind === 'hours'
          ? t('insights.timeAgoHours', { count: relativeTime.count })
          : t('insights.timeAgoDays', { count: relativeTime.count })

  return (
    <div className="flex items-center rounded-md py-1.5 px-3 gap-2.5 hover:bg-surface-active/50 transition-colors">
      <Icon className={cn('size-3 shrink-0', iconColor)} />
      <div className="grow overflow-clip min-w-0">
        <span className="text-foreground font-sans text-xs/4 line-clamp-1">
          {item.itemTitle || t('list.untitled')}
        </span>
      </div>
      <ArrowRight className="size-2.5 shrink-0 text-text-tertiary" />
      <span className="shrink-0 text-text-tertiary font-sans text-[11px]/3.5 truncate max-w-[160px]">
        {isLinked ? t('insights.convertedToTask') : item.filedTo}
      </span>
      <span className="shrink-0 text-text-tertiary font-sans text-[11px]/3.5 tabular-nums">
        {relativeText}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function InboxHealthView({ className }: InboxHealthViewProps): React.JSX.Element {
  const { t } = useT('inbox')
  const { stats, isLoading } = useInboxStats()
  const { data: historyData } = useInboxFilingHistory()
  const { data: patterns } = useInboxPatterns()

  const scrollRef = useRef<HTMLDivElement>(null)
  const getScrollElement = useCallback(() => scrollRef.current, [])
  // While loading, the spinner replaces the whole pane and there is no scroller
  // to restore into; enabling on arrival re-runs the restore.
  useTabScrollRestore({
    getScrollElement,
    key: INBOX_SCROLL_KEYS.insights,
    enabled: !isLoading && !!stats
  })

  if (isLoading || !stats) {
    return (
      <div className={cn('flex h-64 items-center justify-center', className)}>
        <div className="size-6 animate-spin rounded-full border-2 border-accent-orange/30 border-t-accent-orange" />
      </div>
    )
  }

  const filingHistory = historyData?.entries?.slice(0, 6) ?? []
  const processRate =
    stats.capturedThisWeek > 0
      ? Math.round((stats.processedThisWeek / stats.capturedThisWeek) * 100)
      : 0

  return (
    <div
      ref={scrollRef}
      data-inbox-scroll
      className={cn('flex flex-col grow overflow-y-auto pt-[38px]', className)}
    >
      <div className="flex shrink-0 pt-6 gap-3 px-6">
        <StatCard
          label={t('insights.captured')}
          value={stats.totalItems}
          subValue={t('insights.capturedThisWeek', { count: stats.capturedThisWeek })}
          subColor="text-accent-green"
        />
        <StatCard
          label={t('insights.processed')}
          value={stats.processedThisWeek}
          subValue={t('insights.processRate', { rate: processRate })}
        />
        <StatCard
          label={t('insights.stale')}
          value={stats.staleCount}
          subValue={stats.staleCount > 0 ? t('insights.needsAttention') : t('insights.allClear')}
          subColor={stats.staleCount > 0 ? 'text-destructive' : 'text-accent-green'}
          borderColor={stats.staleCount > 0 ? 'border-destructive/15' : 'border-border/50'}
        />
        <StatCard
          label={t('insights.avgTimeToFile')}
          value={formatAvgTime(stats.avgTimeToProcess)}
          subValue=""
        />
      </div>

      <div className="flex shrink-0 pt-4 gap-3 px-6">
        <CaptureHeatmap patterns={patterns} />
        <TypeDistribution itemsByType={stats.itemsByType} />
      </div>

      <div className="flex flex-col shrink-0 pt-4 gap-3 px-6 pb-6">
        <div className="text-muted-foreground font-sans font-medium text-xs/4">
          {t('insights.recentFilings')}
        </div>
        {filingHistory.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {filingHistory.map((item) => (
              <FilingRow key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-muted-foreground font-serif text-sm italic">
            {t('empty.noItemsFiled')}
          </div>
        )}
      </div>
    </div>
  )
}
