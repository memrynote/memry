interface TriageProgressProps {
  completed: number
  total: number
}

export function TriageProgress({ completed, total }: TriageProgressProps): React.JSX.Element {
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0

  return (
    <div className="flex h-[3px] w-full overflow-hidden rounded-sm bg-foreground/[0.06]">
      <div
        className="h-full rounded-sm bg-tint transition-all duration-500 ease-out"
        style={{ width: `${percentage}%` }}
      />
    </div>
  )
}
