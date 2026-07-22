import { cn } from '@/lib/utils'
import { useT } from '@memry/i18n/renderer'

interface ProjectStatsRowProps {
  taskCount: number
  noteCount: number
  eventCount: number
  fileCount: number
  progressPct: number
  className?: string
}

export const ProjectStatsRow = ({
  taskCount,
  noteCount,
  eventCount,
  fileCount,
  progressPct,
  className
}: ProjectStatsRowProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const tiles = [
    { label: t('projectHome.stats.tasks'), value: String(taskCount) },
    { label: t('projectHome.stats.notes'), value: String(noteCount) },
    { label: t('projectHome.stats.events'), value: String(eventCount) },
    { label: t('projectHome.stats.files'), value: String(fileCount) },
    { label: t('projectHome.stats.progress'), value: `${progressPct}%` }
  ]
  return (
    <div className={cn('grid grid-cols-5 gap-3 px-4 py-3', className)}>
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="rounded-lg border border-border bg-surface p-3 text-center"
        >
          <div className="text-lg font-semibold text-foreground">{tile.value}</div>
          <div className="mt-0.5 text-xs uppercase tracking-wide text-muted-foreground">
            {tile.label}
          </div>
        </div>
      ))}
    </div>
  )
}

export default ProjectStatsRow
