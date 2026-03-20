import { useState, useMemo } from 'react'
import {
  AlertTriangle,
  Archive,
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
import {
  useInboxStats,
  useInboxBankruptcy,
  useInboxFilingHistory,
  useInboxPatterns
} from '@/hooks/use-inbox'
import { cn } from '@/lib/utils'
import type { InboxCapturePattern, InboxFilingHistoryEntry } from '../../../../preload/index.d'

export interface InboxHealthViewProps {
  className?: string
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const
const HEATMAP_HOURS = [6, 8, 10, 12, 14, 16, 18, 20, 22] as const

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

function timeAgo(date: Date): string {
  const ms = Date.now() - date.getTime()
  const mins = Math.floor(ms / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function computePeakInfo(heatmap: number[][]): string {
  const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
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

  if (maxVal === 0) return 'No captures yet'

  const fmtH = (h: number) => {
    if (h === 0 || h === 24) return '12 AM'
    if (h < 12) return `${h} AM`
    if (h === 12) return '12 PM'
    return `${h - 12} PM`
  }

  return `Peak: ${dayNames[peakDay]} ${fmtH(peakHour)}\u2013${fmtH(Math.min(peakHour + 2, 24))}`
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

function CaptureHeatmap({
  patterns
}: {
  patterns: InboxCapturePattern | undefined
}): React.JSX.Element {
  const { maxCount, peakText } = useMemo(() => {
    if (!patterns?.timeHeatmap) return { maxCount: 0, peakText: '' }

    const heatmap = patterns.timeHeatmap
    let max = 0

    for (let day = 0; day < 7; day++) {
      for (const hour of HEATMAP_HOURS) {
        const val = (heatmap[hour]?.[day] ?? 0) + (heatmap[hour + 1]?.[day] ?? 0)
        if (val > max) max = val
      }
    }

    return { maxCount: max, peakText: computePeakInfo(heatmap) }
  }, [patterns])

  if (!patterns?.timeHeatmap) {
    return (
      <div className="flex flex-col grow basis-0 rounded-[10px] border border-border/50 p-4 items-center justify-center min-h-[180px]">
        <span className="text-muted-foreground font-serif text-sm italic">No capture data</span>
      </div>
    )
  }

  const heatmap = patterns.timeHeatmap

  return (
    <div className="flex flex-col grow basis-0 rounded-[10px] gap-3.5 border border-border/50 p-4">
      <div className="text-muted-foreground font-sans font-medium text-xs/4">Capture Activity</div>
      <div className="flex gap-1.5">
        <div className="flex flex-col pt-4 gap-[3px]">
          {DAYS.map((day) => (
            <div key={day} className="h-3 text-text-tertiary font-sans shrink-0 text-[9px]/3">
              {day}
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-[3px]">
          <div className="flex h-3 gap-[3px] shrink-0">
            {HEATMAP_HOURS.map((hour) => (
              <div
                key={hour}
                className="w-3 text-center text-text-tertiary font-sans shrink-0 text-[9px]/3"
              >
                {hour}
              </div>
            ))}
          </div>
          {DAYS.map((_, dayIdx) => (
            <div key={dayIdx} className="flex gap-[3px]">
              {HEATMAP_HOURS.map((hour) => {
                const val = (heatmap[hour]?.[dayIdx] ?? 0) + (heatmap[hour + 1]?.[dayIdx] ?? 0)
                const intensity = maxCount > 0 ? val / maxCount : 0
                return (
                  <div
                    key={hour}
                    className={cn(
                      'rounded-[2px] shrink-0 size-3',
                      intensity === 0 && 'bg-muted/30'
                    )}
                    style={
                      intensity > 0
                        ? {
                            backgroundColor: `color-mix(in srgb, var(--accent-orange) ${Math.round(Math.max(intensity * 90, 5))}%, transparent)`
                          }
                        : undefined
                    }
                    title={`${val} captures`}
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
        <span className="text-muted-foreground font-serif text-sm italic">No items yet</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col grow basis-0 rounded-[10px] gap-3.5 border border-border/50 p-4">
      <div className="text-muted-foreground font-sans font-medium text-xs/4">By Type</div>
      <div className="flex flex-col gap-2.5">
        {sortedTypes.map(([type, count]) => {
          const pct = maxCount > 0 ? (count / maxCount) * 100 : 0
          const barColor = TYPE_BAR_COLORS[type] ?? 'bg-muted-foreground/40'
          const label = type.charAt(0).toUpperCase() + type.slice(1)

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
              <div className="w-5 shrink-0 text-right text-text-tertiary font-sans text-[11px]/3.5 tabular-nums">
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
  const isLinked = item.filedAction === 'linked'
  const Icon = isLinked ? CheckCircle : (TYPE_ICONS[item.itemType] ?? HelpCircle)
  const iconColor = isLinked
    ? 'text-indigo-500 dark:text-indigo-400'
    : (TYPE_ICON_COLORS[item.itemType] ?? 'text-muted-foreground')

  return (
    <div className="flex items-center rounded-md py-1.5 px-3 gap-2.5 hover:bg-surface-active/50 transition-colors">
      <Icon className={cn('size-3 shrink-0', iconColor)} />
      <div className="grow overflow-clip min-w-0">
        <span className="text-foreground font-sans text-xs/4 line-clamp-1">
          {item.itemTitle || 'Untitled'}
        </span>
      </div>
      <ArrowRight className="size-2.5 shrink-0 text-text-tertiary" />
      <span className="shrink-0 text-text-tertiary font-sans text-[11px]/3.5 truncate max-w-[160px]">
        {isLinked ? 'Converted to task' : item.filedTo}
      </span>
      <span className="shrink-0 text-text-tertiary font-sans text-[11px]/3.5 tabular-nums">
        {timeAgo(new Date(item.filedAt))}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collector Warning
// ---------------------------------------------------------------------------

function CollectorWarning({
  ratio,
  oldestDays,
  onDeclare
}: {
  ratio: number
  oldestDays: number
  onDeclare: () => void
}): React.JSX.Element | null {
  if (ratio <= 3 && oldestDays < 21) return null

  const message =
    ratio > 3
      ? "You're collecting faster than processing"
      : `Your oldest item is ${oldestDays} days old`

  const detail =
    ratio > 3
      ? `At ${ratio}:1 this week, your inbox is growing. Triage or declare bankruptcy.`
      : 'Items lose context as they age. Archive what you no longer need.'

  return (
    <div className="relative overflow-hidden rounded-[10px] border border-amber-600/20 dark:border-amber-400/15">
      <div className="absolute inset-y-0 left-0 w-1 bg-amber-500 dark:bg-amber-400" />
      <div className="bg-amber-500/[0.04] px-5 py-4 pl-6">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <div className="flex-1">
            <p className="font-serif text-sm font-semibold text-amber-800 dark:text-amber-300">
              {message}
            </p>
            <p className="text-muted-foreground mt-1 text-xs leading-relaxed">{detail}</p>
          </div>
        </div>
        <button
          onClick={onDeclare}
          className="ml-7 mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-600/10 px-3 py-1.5 text-xs font-semibold text-amber-700 transition-colors hover:bg-amber-600/20 dark:text-amber-300 dark:hover:bg-amber-400/15"
        >
          <Archive className="size-3" />
          Declare Bankruptcy
          <ArrowRight className="size-3" />
        </button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bankruptcy Dialog
// ---------------------------------------------------------------------------

function BankruptcyDialog({
  oldestDays,
  onConfirm,
  onCancel,
  isPending
}: {
  oldestDays: number
  onConfirm: (days: number) => void
  onCancel: () => void
  isPending: boolean
}): React.JSX.Element {
  const presets = [
    { label: '2 weeks', days: 14 },
    { label: '1 month', days: 30 },
    { label: '3 months', days: 90 }
  ].filter((p) => p.days <= oldestDays)

  const [selectedDays, setSelectedDays] = useState(presets[0]?.days ?? 14)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div
        className="bg-card mx-4 w-full max-w-sm rounded-2xl border shadow-2xl"
        style={{ boxShadow: '0 25px 50px -12px rgba(0,0,0,0.25)' }}
      >
        <div className="border-b p-5">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-amber-500/10">
              <Archive className="size-4 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h3 className="font-serif text-base font-semibold">Inbox Bankruptcy</h3>
              <p className="text-muted-foreground text-xs">Archive old unfiled items</p>
            </div>
          </div>
        </div>
        <div className="p-5">
          <p className="text-muted-foreground mb-4 text-xs leading-relaxed">
            Move all unfiled items older than the threshold to Archive. This is reversible.
          </p>
          <div className="flex gap-2">
            {presets.map((p) => (
              <button
                key={p.days}
                onClick={() => setSelectedDays(p.days)}
                className={cn(
                  'flex-1 rounded-lg border px-3 py-2.5 text-sm font-medium transition-all',
                  selectedDays === p.days
                    ? 'border-amber-500/50 bg-amber-500/10 text-amber-700 dark:border-amber-400/40 dark:text-amber-300'
                    : 'border-border hover:bg-accent'
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2 border-t px-5 py-3">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="text-muted-foreground hover:text-foreground rounded-lg px-4 py-2 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selectedDays)}
            disabled={isPending}
            className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-amber-700 disabled:opacity-50 dark:bg-amber-500 dark:hover:bg-amber-600"
          >
            {isPending ? 'Archiving...' : `Archive >${selectedDays}d`}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function InboxHealthView({ className }: InboxHealthViewProps): React.JSX.Element {
  const { stats, isLoading } = useInboxStats()
  const { data: historyData } = useInboxFilingHistory()
  const { data: patterns } = useInboxPatterns()
  const bankruptcy = useInboxBankruptcy()
  const [showBankruptcy, setShowBankruptcy] = useState(false)

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
    <div className={cn('flex flex-col grow overflow-y-auto antialiased', className)}>
      <div className="fade-in-up stagger-1 flex shrink-0 pt-6 gap-3 px-6">
        <StatCard
          label="Captured"
          value={stats.totalItems}
          subValue={`+${stats.capturedThisWeek} this week`}
          subColor="text-accent-green"
        />
        <StatCard
          label="Processed"
          value={stats.processedThisWeek}
          subValue={`${processRate}% rate`}
        />
        <StatCard
          label="Stale"
          value={stats.staleCount}
          subValue={stats.staleCount > 0 ? 'needs attention' : 'all clear'}
          subColor={stats.staleCount > 0 ? 'text-destructive' : 'text-accent-green'}
          borderColor={stats.staleCount > 0 ? 'border-destructive/15' : 'border-border/50'}
        />
        <StatCard
          label="Avg Time to File"
          value={formatAvgTime(stats.avgTimeToProcess)}
          subValue=""
        />
      </div>

      <div className="fade-in-up stagger-2 flex shrink-0 pt-4 gap-3 px-6">
        <CaptureHeatmap patterns={patterns} />
        <TypeDistribution itemsByType={stats.itemsByType} />
      </div>

      <div className="fade-in-up stagger-3 shrink-0 pt-4 px-6">
        <CollectorWarning
          ratio={stats.captureProcessRatio}
          oldestDays={stats.oldestItemDays}
          onDeclare={() => setShowBankruptcy(true)}
        />
      </div>

      <div className="fade-in-up stagger-4 flex flex-col shrink-0 pt-4 gap-3 px-6 pb-6">
        <div className="text-muted-foreground font-sans font-medium text-xs/4">Recent Filings</div>
        {filingHistory.length > 0 ? (
          <div className="flex flex-col gap-0.5">
            {filingHistory.map((item) => (
              <FilingRow key={item.id} item={item} />
            ))}
          </div>
        ) : (
          <div className="py-6 text-center text-muted-foreground font-serif text-sm italic">
            No items filed yet
          </div>
        )}
      </div>

      {showBankruptcy && (
        <BankruptcyDialog
          oldestDays={stats.oldestItemDays}
          isPending={bankruptcy.isPending}
          onCancel={() => setShowBankruptcy(false)}
          onConfirm={(days) => {
            bankruptcy.mutate(days, {
              onSuccess: () => setShowBankruptcy(false)
            })
          }}
        />
      )}
    </div>
  )
}
