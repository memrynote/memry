import { useState, useMemo } from 'react'
import { AlertTriangle, Flame, Archive, ArrowRight, Inbox, Clock, Zap, Moon } from 'lucide-react'
import { useInboxStats, useInboxBankruptcy, useInboxFilingHistory } from '@/hooks/use-inbox'
import { InboxFilingHistoryList } from '@/components/inbox/inbox-filing-history'
import { cn } from '@/lib/utils'

export interface InboxHealthViewProps {
  className?: string
}

// ---------------------------------------------------------------------------
// Arc Gauge — SVG ratio visualization
// ---------------------------------------------------------------------------

function ArcGauge({
  ratio,
  captured,
  processed
}: {
  ratio: number
  captured: number
  processed: number
}) {
  const clampedRatio = Math.min(ratio, 8)
  const progress = Math.min(clampedRatio / 5, 1)
  const isHealthy = ratio <= 2
  const isWarning = ratio > 2 && ratio <= 3
  const isDanger = ratio > 3

  const size = 160
  const stroke = 10
  const r = (size - stroke) / 2
  const cx = size / 2
  const cy = size / 2

  const startAngle = 135
  const endAngle = 405
  const totalAngle = endAngle - startAngle
  const valueAngle = startAngle + totalAngle * progress

  const toRad = (deg: number) => ((deg - 90) * Math.PI) / 180
  const arcPath = (start: number, end: number) => {
    const s = { x: cx + r * Math.cos(toRad(start)), y: cy + r * Math.sin(toRad(start)) }
    const e = { x: cx + r * Math.cos(toRad(end)), y: cy + r * Math.sin(toRad(end)) }
    const large = end - start > 180 ? 1 : 0
    return `M ${s.x} ${s.y} A ${r} ${r} 0 ${large} 1 ${e.x} ${e.y}`
  }

  const strokeColor = isDanger
    ? 'stroke-red-500 dark:stroke-red-400'
    : isWarning
      ? 'stroke-amber-500 dark:stroke-amber-400'
      : 'stroke-emerald-500 dark:stroke-emerald-400'

  const textColor = isDanger
    ? 'text-red-600 dark:text-red-400'
    : isWarning
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400'

  return (
    <div className="flex flex-col items-center">
      <svg
        width={size}
        height={size - 20}
        viewBox={`0 0 ${size} ${size - 10}`}
        className="overflow-visible"
      >
        <path
          d={arcPath(startAngle, endAngle)}
          fill="none"
          className="stroke-border/40"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
        {progress > 0 && (
          <path
            d={arcPath(startAngle, valueAngle)}
            fill="none"
            className={strokeColor}
            strokeWidth={stroke}
            strokeLinecap="round"
            style={{
              filter: isDanger ? 'drop-shadow(0 0 6px rgba(239,68,68,0.3))' : undefined
            }}
          />
        )}
        <text
          x={cx}
          y={cy - 6}
          textAnchor="middle"
          className={cn('font-display text-[42px] font-bold', textColor)}
          fill="currentColor"
        >
          {ratio > 0 ? `${ratio}` : '0'}
        </text>
        <text
          x={cx}
          y={cy + 16}
          textAnchor="middle"
          className="fill-muted-foreground font-serif text-[13px]"
          fill="currentColor"
        >
          : 1 ratio
        </text>
      </svg>
      <div className="mt-1 flex items-center gap-4 text-xs">
        <span className="text-muted-foreground">
          <strong className="text-foreground font-display tabular-nums">{captured}</strong> in
        </span>
        <span className="bg-border/60 h-3 w-px" />
        <span className="text-muted-foreground">
          <strong className="text-foreground font-display tabular-nums">{processed}</strong> out
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Age Strata — vertical layered visualization
// ---------------------------------------------------------------------------

function AgeStrata({ fresh, aging, stale }: { fresh: number; aging: number; stale: number }) {
  const total = fresh + aging + stale

  if (total === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground font-serif text-sm italic">Inbox clear</p>
      </div>
    )
  }

  const layers = [
    {
      label: 'Fresh',
      count: fresh,
      range: '<3d',
      color: 'bg-emerald-500/60 dark:bg-emerald-400/50',
      dot: 'bg-emerald-500'
    },
    {
      label: 'Aging',
      count: aging,
      range: '3–7d',
      color: 'bg-amber-500/50 dark:bg-amber-400/40',
      dot: 'bg-amber-500'
    },
    {
      label: 'Stale',
      count: stale,
      range: '>7d',
      color: 'bg-red-500/40 dark:bg-red-400/30',
      dot: 'bg-red-500'
    }
  ]

  return (
    <div className="flex flex-col gap-2">
      {layers.map((layer) => {
        const pct = total > 0 ? (layer.count / total) * 100 : 0
        return (
          <div key={layer.label} className="group flex items-center gap-3">
            <div className="w-20 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                <span className={cn('size-1.5 rounded-full', layer.dot)} />
                <span className="text-muted-foreground text-[11px] font-medium uppercase tracking-wider">
                  {layer.label}
                </span>
              </div>
              <span className="text-muted-foreground/50 ml-3 text-[10px]">{layer.range}</span>
            </div>
            <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded">
              <div
                className={cn(
                  'absolute inset-y-0 left-0 rounded transition-all duration-700 ease-out',
                  layer.color
                )}
                style={{ width: `${Math.max(pct, 2)}%` }}
              />
              <span className="relative z-10 flex h-full items-center px-2.5 text-xs font-bold tabular-nums">
                {layer.count}
              </span>
            </div>
          </div>
        )
      })}
      <div className="text-muted-foreground/60 mt-1 text-right text-[10px] tabular-nums">
        {total} pending
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Streak dots — visual habit tracker
// ---------------------------------------------------------------------------

function StreakDots({ streak }: { streak: number }) {
  const dots = useMemo(() => {
    const filled = Math.min(streak, 14)
    const empty = 14 - filled
    return { filled, empty }
  }, [streak])

  return (
    <div className="flex items-center gap-3">
      <Flame
        className={cn(
          'size-5 shrink-0',
          streak > 0 ? 'text-orange-500' : 'text-muted-foreground/30'
        )}
      />
      <div className="flex min-w-0 flex-1 items-center gap-[3px]">
        {Array.from({ length: dots.filled }, (_, i) => (
          <div
            key={`f-${i}`}
            className="size-2 rounded-full bg-orange-500/80 dark:bg-orange-400/70"
            style={{ animationDelay: `${i * 40}ms` }}
          />
        ))}
        {Array.from({ length: dots.empty }, (_, i) => (
          <div key={`e-${i}`} className="bg-border/50 size-2 rounded-full" />
        ))}
      </div>
      <div className="shrink-0 text-right">
        <span className="font-display text-lg font-bold tabular-nums leading-none">{streak}</span>
        <span className="text-muted-foreground ml-1 text-[10px]">
          {streak === 1 ? 'day' : 'days'}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Collector warning — editorial pull-quote
// ---------------------------------------------------------------------------

function CollectorWarning({
  ratio,
  oldestDays,
  onDeclare
}: {
  ratio: number
  oldestDays: number
  onDeclare: () => void
}) {
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
    <div className="relative overflow-hidden rounded-xl border border-amber-600/20 dark:border-amber-400/15">
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
// Bankruptcy dialog
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
}) {
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
// Stat pill — compact inline stat
// ---------------------------------------------------------------------------

function StatPill({
  icon: Icon,
  label,
  value
}: {
  icon: typeof Inbox
  label: string
  value: string | number
}) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-border/40 bg-card px-3 py-2">
      <Icon className="text-muted-foreground/60 size-3.5" />
      <div className="flex items-baseline gap-1.5">
        <span className="font-display text-base font-bold tabular-nums leading-none">{value}</span>
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider">{label}</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main health view
// ---------------------------------------------------------------------------

export function InboxHealthView({ className }: InboxHealthViewProps): React.JSX.Element {
  const { stats, isLoading } = useInboxStats()
  const { data: historyData } = useInboxFilingHistory()
  const bankruptcy = useInboxBankruptcy()
  const [showBankruptcy, setShowBankruptcy] = useState(false)

  if (isLoading || !stats) {
    return (
      <div className={cn('flex h-64 items-center justify-center', className)}>
        <div className="size-6 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-500" />
      </div>
    )
  }

  const filingHistory = historyData?.entries ?? []

  return (
    <div className={cn('mx-auto max-w-2xl space-y-6 px-6 py-6 pb-12', className)}>
      {/* Section: Pulse */}
      <div className="fade-in-up stagger-1">
        <div className="journal-section-label mb-3">Weekly Pulse</div>
        <div className="grid grid-cols-[auto_1fr] gap-6 rounded-xl border border-border/50 bg-card p-5">
          <ArcGauge
            ratio={stats.captureProcessRatio}
            captured={stats.capturedThisWeek}
            processed={stats.processedThisWeek}
          />
          <div className="flex flex-col justify-between py-1">
            <div className="flex flex-wrap gap-2">
              <StatPill icon={Inbox} label="pending" value={stats.totalItems} />
              <StatPill icon={Zap} label="today" value={stats.processedToday} />
              <StatPill
                icon={Clock}
                label="avg"
                value={stats.avgTimeToProcess > 0 ? `${Math.round(stats.avgTimeToProcess)}m` : '—'}
              />
              <StatPill icon={Moon} label="snoozed" value={stats.snoozedCount} />
            </div>
            <StreakDots streak={stats.currentStreak} />
          </div>
        </div>
      </div>

      {/* Section: Age */}
      <div className="fade-in-up stagger-2">
        <div className="journal-section-label mb-3">Item Age</div>
        <div className="rounded-xl border border-border/50 bg-card p-5">
          <AgeStrata
            fresh={stats.ageDistribution.fresh}
            aging={stats.ageDistribution.aging}
            stale={stats.ageDistribution.stale}
          />
        </div>
      </div>

      {/* Section: Warning */}
      <div className="fade-in-up stagger-3">
        <CollectorWarning
          ratio={stats.captureProcessRatio}
          oldestDays={stats.oldestItemDays}
          onDeclare={() => setShowBankruptcy(true)}
        />
      </div>

      {/* Section: History */}
      <div className="fade-in-up stagger-4">
        <div className="journal-section-label mb-3">Recent Activity</div>
        <InboxFilingHistoryList items={filingHistory} />
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
