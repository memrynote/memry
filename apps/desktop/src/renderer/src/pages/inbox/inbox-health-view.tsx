import { useState } from 'react'
import { AlertTriangle, TrendingUp, TrendingDown, Flame, Archive, ArrowRight } from 'lucide-react'
import { useInboxStats, useInboxBankruptcy, useInboxFilingHistory } from '@/hooks/use-inbox'
import { InboxFilingHistoryList } from '@/components/inbox/inbox-filing-history'
import { cn } from '@/lib/utils'

export interface InboxHealthViewProps {
  className?: string
}

function RatioDisplay({ captured, processed }: { captured: number; processed: number }) {
  const ratio = processed > 0 ? Math.round((captured / processed) * 10) / 10 : captured
  const isHealthy = ratio <= 2
  const isWarning = ratio > 2 && ratio <= 3
  const isDanger = ratio > 3

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-serif text-lg font-medium">Capture vs Process</h3>
        {isDanger && <AlertTriangle className="size-5 text-amber-500" />}
      </div>

      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            'font-display text-5xl font-bold tabular-nums tracking-tight',
            isHealthy && 'text-emerald-600 dark:text-emerald-400',
            isWarning && 'text-amber-600 dark:text-amber-400',
            isDanger && 'text-red-600 dark:text-red-400'
          )}
        >
          {ratio > 0 ? `${ratio}:1` : '0'}
        </span>
        <span className="text-muted-foreground text-sm">ratio this week</span>
      </div>

      <div className="mt-4 flex gap-6 text-sm">
        <div className="flex items-center gap-2">
          <TrendingUp className="text-muted-foreground size-4" />
          <span className="text-muted-foreground">
            <strong className="text-foreground">{captured}</strong> captured
          </span>
        </div>
        <div className="flex items-center gap-2">
          <TrendingDown className="text-muted-foreground size-4" />
          <span className="text-muted-foreground">
            <strong className="text-foreground">{processed}</strong> processed
          </span>
        </div>
      </div>
    </div>
  )
}

function AgeDistributionBar({
  fresh,
  aging,
  stale
}: {
  fresh: number
  aging: number
  stale: number
}) {
  const total = fresh + aging + stale
  if (total === 0) {
    return (
      <div className="rounded-xl border border-border/50 bg-card p-6">
        <h3 className="font-serif text-lg font-medium">Age Distribution</h3>
        <p className="text-muted-foreground mt-2 text-sm italic">No pending items</p>
      </div>
    )
  }

  const freshPct = (fresh / total) * 100
  const agingPct = (aging / total) * 100
  const stalePct = (stale / total) * 100

  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="font-serif text-lg font-medium">Age Distribution</h3>
        <span className="text-muted-foreground font-display text-sm tabular-nums">
          {total} items
        </span>
      </div>

      <div className="mb-3 flex h-4 overflow-hidden rounded-full">
        {freshPct > 0 && (
          <div
            className="bg-emerald-500/70 transition-all duration-500"
            style={{ width: `${freshPct}%` }}
            title={`Fresh: ${fresh}`}
          />
        )}
        {agingPct > 0 && (
          <div
            className="bg-amber-500/70 transition-all duration-500"
            style={{ width: `${agingPct}%` }}
            title={`Aging: ${aging}`}
          />
        )}
        {stalePct > 0 && (
          <div
            className="bg-red-500/70 transition-all duration-500"
            style={{ width: `${stalePct}%` }}
            title={`Stale: ${stale}`}
          />
        )}
      </div>

      <div className="flex justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-emerald-500/70" />
          <span className="text-muted-foreground">
            Fresh <strong className="text-foreground">{fresh}</strong>
          </span>
          <span className="text-muted-foreground/50 ml-1">&lt;3d</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-amber-500/70" />
          <span className="text-muted-foreground">
            Aging <strong className="text-foreground">{aging}</strong>
          </span>
          <span className="text-muted-foreground/50 ml-1">3-7d</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-red-500/70" />
          <span className="text-muted-foreground">
            Stale <strong className="text-foreground">{stale}</strong>
          </span>
          <span className="text-muted-foreground/50 ml-1">&gt;7d</span>
        </div>
      </div>
    </div>
  )
}

function StreakCard({ streak }: { streak: number }) {
  return (
    <div className="rounded-xl border border-border/50 bg-card p-6">
      <div className="mb-2 flex items-center gap-2">
        <Flame
          className={cn('size-5', streak > 0 ? 'text-orange-500' : 'text-muted-foreground/40')}
        />
        <h3 className="font-serif text-lg font-medium">Processing Streak</h3>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-display text-4xl font-bold tabular-nums tracking-tight">
          {streak}
        </span>
        <span className="text-muted-foreground text-sm">
          {streak === 1 ? 'day' : 'days'} in a row
        </span>
      </div>
      {streak === 0 && (
        <p className="text-muted-foreground mt-2 text-xs">Process at least 1 item to start</p>
      )}
    </div>
  )
}

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

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
        <div className="flex-1">
          <h4 className="font-serif font-medium text-amber-700 dark:text-amber-400">
            {ratio > 3
              ? "You're collecting faster than processing"
              : `Your oldest item is ${oldestDays} days old`}
          </h4>
          <p className="text-muted-foreground mt-1 text-sm">
            {ratio > 3
              ? `At ${ratio}:1 this week, your inbox is growing. Consider a triage session or declaring bankruptcy on old items.`
              : 'Items lose context as they age. Consider archiving items you no longer need.'}
          </p>
          <button
            onClick={onDeclare}
            className="text-foreground bg-amber-500/10 hover:bg-amber-500/20 mt-3 inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors"
          >
            <Archive className="size-3.5" />
            Declare Inbox Bankruptcy
            <ArrowRight className="size-3" />
          </button>
        </div>
      </div>
    </div>
  )
}

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
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center backdrop-blur-sm">
      <div className="bg-card mx-4 w-full max-w-md rounded-2xl border p-6 shadow-xl">
        <div className="mb-4 flex items-center gap-3">
          <div className="rounded-full bg-amber-500/10 p-2">
            <Archive className="size-5 text-amber-500" />
          </div>
          <h3 className="font-serif text-lg font-semibold">Inbox Bankruptcy</h3>
        </div>

        <p className="text-muted-foreground mb-4 text-sm">
          Archive all unfiled items older than the selected threshold. This is reversible — items
          move to the Archive tab.
        </p>

        <div className="mb-6 flex gap-2">
          {presets.map((p) => (
            <button
              key={p.days}
              onClick={() => setSelectedDays(p.days)}
              className={cn(
                'flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                selectedDays === p.days
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border hover:bg-accent'
              )}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="text-muted-foreground hover:bg-accent rounded-lg px-4 py-2 text-sm transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(selectedDays)}
            disabled={isPending}
            className="bg-amber-600 hover:bg-amber-700 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50"
          >
            {isPending ? 'Archiving...' : `Archive items older than ${selectedDays}d`}
          </button>
        </div>
      </div>
    </div>
  )
}

function QuickStatsRow({
  stats
}: {
  stats: {
    totalItems: number
    processedToday: number
    avgTimeToProcess: number
    snoozedCount: number
  }
}) {
  const cards = [
    { label: 'Pending', value: stats.totalItems, trend: null },
    {
      label: 'Processed today',
      value: stats.processedToday,
      trend: stats.processedToday > 0 ? 'up' : null
    },
    {
      label: 'Avg process time',
      value: stats.avgTimeToProcess > 0 ? `${Math.round(stats.avgTimeToProcess)}m` : '—',
      trend: null
    },
    { label: 'Snoozed', value: stats.snoozedCount, trend: null }
  ] as Array<{ label: string; value: string | number; trend: 'up' | 'down' | null }>

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((card) => (
        <div key={card.label} className="rounded-xl border border-border/50 bg-card px-4 py-3">
          <span className="text-muted-foreground text-xs font-medium">{card.label}</span>
          <div className="mt-1 flex items-center gap-1.5">
            <span className="font-display text-2xl font-bold tabular-nums tracking-tight">
              {card.value}
            </span>
            {card.trend === 'up' && <TrendingUp className="size-3 text-emerald-500" />}
            {card.trend === 'down' && <TrendingDown className="size-3 text-red-500" />}
          </div>
        </div>
      ))}
    </div>
  )
}

export function InboxHealthView({ className }: InboxHealthViewProps): React.JSX.Element {
  const { stats, isLoading } = useInboxStats()
  const { data: historyData } = useInboxFilingHistory()
  const bankruptcy = useInboxBankruptcy()
  const [showBankruptcy, setShowBankruptcy] = useState(false)

  if (isLoading || !stats) {
    return (
      <div className={cn('flex h-64 items-center justify-center', className)}>
        <div className="bg-muted/50 h-8 w-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
      </div>
    )
  }

  const filingHistory = historyData?.entries ?? []

  return (
    <div className={cn('space-y-6 pb-8', className)}>
      <QuickStatsRow stats={stats} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RatioDisplay captured={stats.capturedThisWeek} processed={stats.processedThisWeek} />
        <AgeDistributionBar
          fresh={stats.ageDistribution.fresh}
          aging={stats.ageDistribution.aging}
          stale={stats.ageDistribution.stale}
        />
      </div>

      <StreakCard streak={stats.currentStreak} />

      <CollectorWarning
        ratio={stats.captureProcessRatio}
        oldestDays={stats.oldestItemDays}
        onDeclare={() => setShowBankruptcy(true)}
      />

      <InboxFilingHistoryList items={filingHistory} />

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
