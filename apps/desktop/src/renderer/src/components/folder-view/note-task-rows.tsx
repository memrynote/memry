/**
 * Task UI of the folder table: the chevron and progress badge on a note row,
 * and the list of that note's tasks that opens beneath it.
 */

import { useT } from '@memry/i18n/renderer'
import { useTasksContext } from '@/contexts/tasks'
import { useRemindersForTarget } from '@/hooks/use-reminders'
import type { NoteTasks } from '@/lib/note-tasks'
import { formatDateShort } from '@/lib/task-utils'
import { Bell, ChevronDown } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { TaskRow } from '@/components/tasks/task-row'
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
      className="relative flex size-5 items-center justify-center rounded after:absolute after:-inset-0.5 after:content-[''] text-text-tertiary hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
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
  const { tasks, projects, updateTask } = useTasksContext()
  const openTaskDetail = useOpenTaskDetail()

  const toggleComplete = (taskId: string): void => {
    const target = tasks.find((task) => task.id === taskId)
    if (target) void updateTask(taskId, { completedAt: target.completedAt ? null : new Date() })
  }

  return (
    <ul
      aria-label={t('folderView.noteTasks.list', { title: noteTitle })}
      className="m-0 w-full list-none py-1"
      style={{ paddingInlineStart: startInset }}
    >
      {summary.tasks.map((task) => {
        // The same row the note's task block renders, so a task reads the same here.
        const project = projects.find((p) => p.id === task.projectId) ?? projects[0]
        if (!project) return null
        const preview = descriptionPreview(task.description)
        const isCompleted = task.completedAt !== null
        return (
          <li key={task.id}>
            <TaskRow
              task={task}
              project={project}
              projects={projects}
              isCompleted={isCompleted}
              showProjectBadge
              onToggleComplete={toggleComplete}
              onUpdateTask={(taskId, updates) => void updateTask(taskId, updates)}
              onProjectChange={(projectId) => void updateTask(task.id, { projectId })}
              onClick={openTaskDetail}
              renderTitle={() => (
                <span className="flex min-w-0 grow items-baseline gap-2">
                  <span
                    className={cn(
                      'truncate text-[13px] font-medium',
                      isCompleted
                        ? 'text-muted-foreground/60 line-through decoration-1'
                        : 'text-foreground/90'
                    )}
                  >
                    {task.title}
                  </span>
                  {preview && (
                    <span className="truncate text-xs text-muted-foreground">{preview}</span>
                  )}
                </span>
              )}
              actions={<ReminderMark taskId={task.id} />}
              className="px-3"
            />
          </li>
        )
      })}
    </ul>
  )
}
