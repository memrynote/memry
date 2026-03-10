interface TriageProgressProps {
  current: number
  total: number
  completed: number
}

export function TriageProgress({
  current,
  total,
  completed
}: TriageProgressProps): React.JSX.Element {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="flex items-center gap-4 px-6 py-3">
      <div className="flex-1">
        <div className="bg-muted h-2 overflow-hidden rounded-full">
          <div
            className="bg-primary h-full rounded-full transition-all duration-500 ease-out"
            style={{ width: `${percentage}%` }}
          />
        </div>
      </div>
      <div className="text-muted-foreground flex items-center gap-2 text-sm tabular-nums">
        <span className="font-medium">
          {current + 1} of {total}
        </span>
        <span className="text-muted-foreground/60">·</span>
        <span>{percentage}%</span>
      </div>
    </div>
  )
}
