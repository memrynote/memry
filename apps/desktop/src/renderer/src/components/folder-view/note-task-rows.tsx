/**
 * Task UI of the folder table: the chevron and progress badge on a note row,
 * and the list of that note's tasks that opens beneath it.
 */

import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { useRemindersForTarget } from '@/hooks/use-reminders'
import type { Task } from '@/data/task-model'
import type { NoteTasks } from '@/lib/note-tasks'
import { formatDateShort } from '@/lib/task-utils'
import { ArrowRight, Bell, ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TaskCheckbox, TaskTagsBadge } from '@/components/tasks/task-badges'
import { useOpenTaskDetail } from '@/components/tasks/task-detail-host'

export const NOTE_TASK_CHEVRON_WIDTH = 24

interface NoteTaskChevronProps {
  noteTitle: string
  isExpanded: boolean
  onToggle: () => void
}

export const NoteTaskChevron = ({
  noteTitle,
  isExpanded,
  onToggle
}: NoteTaskChevronProps): React.JSX.Element => {
  const { t } = useT('notes')
  return (
    <button
      type="button"
      aria-expanded={isExpanded}
      aria-label={t(isExpanded ? 'folderView.noteTasks.collapse' : 'folderView.noteTasks.expand', {
        title: noteTitle
      })}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className="flex size-5 items-center justify-center rounded text-text-tertiary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ChevronDown
        size={12}
        className={cn('transition-transform', !isExpanded && '-rotate-90 rtl:rotate-90')}
      />
    </button>
  )
}

/** "2/5 open" while work remains, "5/5 done" once it is all finished, and the next due date. */
export const NoteTasksBadge = ({ summary }: { summary: NoteTasks }): React.JSX.Element => {
  const { t } = useT('notes')
  const progress =
    summary.open === 0
      ? t('folderView.noteTasks.progressDone', { total: summary.total })
      : t('folderView.noteTasks.progressOpen', { open: summary.open, total: summary.total })
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
      <span>{progress}</span>
      {summary.nextDue && (
        <span title={t('folderView.noteTasks.nextDue')}>· {formatDateShort(summary.nextDue)}</span>
      )}
    </span>
  )
}

const ReminderMark = ({ taskId }: { taskId: string }): React.JSX.Element | null => {
  const { t } = useT('notes')
  const { reminders } = useRemindersForTarget('task', taskId)
  const hasActive = reminders.some((r) => r.status === 'pending' || r.status === 'snoozed')
  if (!hasActive) return null
  return (
    <Bell
      size={13}
      className="shrink-0 text-muted-foreground"
      aria-label={t('folderView.noteTasks.reminder')}
      role="img"
    />
  )
}

/** First non-empty line of the markdown description, which is all a row has room for. */
const descriptionPreview = (markdown: string): string =>
  markdown
    .split('\n')
    .map((line) => line.replace(/^\s*(#{1,6}|[-*+]|\d+\.|- \[[ xX]\])\s+/, '').trim())
    .find((line) => line.length > 0) ?? ''

const DateRange = ({ task }: { task: Task }): React.JSX.Element | null => {
  if (!task.startDate && !task.dueDate) return null
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
      {task.startDate && <span>{formatDateShort(task.startDate)}</span>}
      {task.startDate && task.dueDate && <ArrowRight size={11} className="rtl:rotate-180" />}
      {task.dueDate && <span>{formatDateShort(task.dueDate)}</span>}
    </span>
  )
}

interface NoteTaskListProps {
  noteTitle: string
  summary: NoteTasks
  /** Space the select and chevron columns take, so tasks line up under the title. */
  startInset: number
}

export const NoteTaskList = ({
  noteTitle,
  summary,
  startInset
}: NoteTaskListProps): React.JSX.Element => {
  const { t } = useT('notes')
  const { updateTask } = useTasksContext()
  const openTaskDetail = useOpenTaskDetail()

  return (
    <ul
      aria-label={t('folderView.noteTasks.list', { title: noteTitle })}
      className="m-0 w-full list-none bg-muted/20 py-1"
      style={{ paddingInlineStart: startInset }}
    >
      {summary.tasks.map((task) => {
        const preview = descriptionPreview(task.description)
        return (
          <li key={task.id}>
            {/* The row is a mouse target only; its title button is the keyboard one. */}
            <div
              onClick={() => openTaskDetail(task.id)}
              className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-muted/50"
            >
              <TaskCheckbox
                size="sm"
                checked={task.completedAt !== null}
                onChange={() =>
                  void updateTask(task.id, { completedAt: task.completedAt ? null : new Date() })
                }
              />
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <button
                  type="button"
                  className={cn(
                    'truncate text-start text-sm focus-visible:outline-none focus-visible:underline',
                    task.completedAt && 'text-muted-foreground line-through'
                  )}
                >
                  {task.title}
                </button>
                {preview && (
                  <span className="truncate text-xs text-muted-foreground">{preview}</span>
                )}
              </div>
              <DateRange task={task} />
              <ReminderMark taskId={task.id} />
              {task.tags.length > 0 && <TaskTagsBadge tags={task.tags} size="sm" maxVisible={2} />}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
