import type { ReactNode } from 'react'
import { XCircle } from '@/lib/icons'
import { cn } from '@/lib/utils'

type StatusTone = 'ready' | 'progress' | 'idle'

const STATUS_DOT: Record<StatusTone, string> = {
  ready: 'bg-emerald-500',
  progress: 'bg-amber-500',
  idle: 'border border-muted-foreground/60'
}

export function StatusIndicator({
  tone,
  label,
  title
}: {
  tone: StatusTone
  label: string
  title?: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 text-xs/4 text-muted-foreground"
    >
      <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[tone])} />
      {label}
    </span>
  )
}

interface LocalModelRowProps {
  label: string
  modelName: string
  hint: string
  status: ReactNode
  action: ReactNode
}

export function LocalModelRow({ label, modelName, hint, status, action }: LocalModelRowProps) {
  return (
    <div className="flex items-center justify-between gap-4 min-h-14 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="shrink-0 text-[13px]/4 text-foreground">{label}</span>
          <span className="truncate font-mono text-xs/4 text-muted-foreground">{modelName}</span>
        </div>
        <span className="text-xs/4 text-muted-foreground">{hint}</span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <div className="w-28">{status}</div>
        <div className="flex min-w-32 justify-end">{action}</div>
      </div>
    </div>
  )
}

export function InlineProgress({
  label,
  value,
  percent
}: {
  label: string
  value: string
  percent: number
}) {
  return (
    <div className="flex flex-col gap-1.5 pb-3">
      <div className="flex justify-between gap-4 text-xs/4 text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- custom progress bar; native progress element cannot take this styling
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-[var(--tint)] transition-all duration-300"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

export function RowError({ message }: { message: string }) {
  return (
    <p className="flex items-center gap-1 pb-3 text-xs/4 text-destructive">
      <XCircle className="size-3.5 shrink-0" />
      {message}
    </p>
  )
}
