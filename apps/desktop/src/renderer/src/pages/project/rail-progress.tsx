import { useT } from '@memry/i18n/renderer'
import { AlertCircle } from '@/lib/icons'
import { StatusIcon } from '@/components/tasks/status-icon'
import type { ProjectProgress } from './use-project-hub'

interface RailProgressProps {
  progress: ProjectProgress
}

export const RailProgress = ({ progress }: RailProgressProps): React.JSX.Element => {
  const { t } = useT('tasks')

  return (
    <section className="px-4 py-3">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('projectHub.rail.progress')}
      </h3>

      <div className="mb-1 flex items-baseline justify-between text-sm">
        <span className="text-muted-foreground">
          {t('projectHub.rail.doneOf', { done: progress.done, total: progress.total })}
        </span>
        <span className="tabular-nums text-foreground">{progress.pct}%</span>
      </div>

      <div
        role="progressbar"
        aria-valuenow={progress.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t('projectHub.rail.progress')}
        className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-surface"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width] motion-reduce:transition-none"
          style={{ width: `${progress.pct}%` }}
        />
      </div>

      <ul className="space-y-1">
        {progress.statuses.map((status) => (
          <li key={status.id} className="flex items-center gap-2 text-sm">
            <StatusIcon type={status.type} color={status.color} />
            <span className="min-w-0 flex-1 truncate text-foreground">{status.name}</span>
            <span className="tabular-nums text-muted-foreground">{status.count}</span>
          </li>
        ))}

        {progress.overdue > 0 ? (
          <li className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{t('projectHub.rail.overdue')}</span>
            <span className="tabular-nums">{progress.overdue}</span>
          </li>
        ) : null}
      </ul>
    </section>
  )
}
