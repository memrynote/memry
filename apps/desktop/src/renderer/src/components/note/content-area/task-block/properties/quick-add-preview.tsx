import { useT } from '@memry/i18n/renderer'
import { Calendar, Hash, Repeat } from '@/lib/icons'
import { formatDateShort, formatTime } from '@/lib/task-utils'
import { getRepeatDisplayText } from '@/lib/repeat-utils'
import { useGeneralSettings } from '@/hooks/use-general-settings'
import { priorityConfig, type Task } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { PriorityIcon } from '@/components/tasks/task-icons'
import { PropertyChip } from './property-chip'

interface QuickAddPreviewProps {
  changes: Partial<Task>
  projects: Project[]
  /** Tags the task already has; the preview shows only the ones being added. */
  existingTags: string[]
}

/**
 * Dashed stand-ins for what the typed shorthand will set, so `!high #launch
 * @fri` reads as properties before ↵ applies them. Not interactive: the text
 * in the title is still the thing being edited.
 */
export const QuickAddPreview = ({
  changes,
  projects,
  existingTags
}: QuickAddPreviewProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const { t: tCommon } = useT('common')
  const {
    settings: { clockFormat }
  } = useGeneralSettings()
  const project = changes.projectId ? projects.find((p) => p.id === changes.projectId) : null
  const existing = new Set(existingTags.map((tag) => tag.toLowerCase()))
  const addedTags = (changes.tags ?? []).filter((tag) => !existing.has(tag.toLowerCase()))

  return (
    <div
      className="flex min-w-0 shrink items-center gap-1 overflow-x-clip"
      aria-label={t('inlineProperties.shorthandPreview')}
    >
      {changes.priority && (
        <PropertyChip
          tone="ghost"
          tabIndex={-1}
          icon={<PriorityIcon priority={changes.priority} className="size-3" />}
        >
          {priorityConfig[changes.priority].label}
        </PropertyChip>
      )}
      {changes.repeatConfig && (
        <PropertyChip
          tone="ghost"
          tabIndex={-1}
          icon={<Repeat className="size-3 shrink-0" aria-hidden="true" />}
        >
          {getRepeatDisplayText(changes.repeatConfig, tCommon)}
        </PropertyChip>
      )}
      {addedTags.length > 0 && (
        <PropertyChip
          tone="ghost"
          tabIndex={-1}
          icon={<Hash className="size-3 shrink-0" aria-hidden="true" />}
        >
          {addedTags.join(', ')}
        </PropertyChip>
      )}
      {changes.dueDate && (
        <PropertyChip
          tone="ghost"
          tabIndex={-1}
          icon={<Calendar size={12} className="shrink-0" aria-hidden="true" />}
        >
          {changes.dueTime
            ? `${formatDateShort(changes.dueDate)}, ${formatTime(changes.dueTime, clockFormat)}`
            : formatDateShort(changes.dueDate)}
        </PropertyChip>
      )}
      {project && (
        <PropertyChip
          tone="ghost"
          tabIndex={-1}
          icon={
            <span
              className="size-2 shrink-0 rounded-xs"
              style={{ backgroundColor: project.color }}
              aria-hidden="true"
            />
          }
        >
          {project.name}
        </PropertyChip>
      )}
    </div>
  )
}
