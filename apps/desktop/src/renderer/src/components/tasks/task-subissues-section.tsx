import { useRef, useState } from 'react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { Plus } from '@/lib/icons'
import type { Task } from '@/data/task-model'
import type { Status } from '@/data/tasks-data'
import { StatusIcon } from './status-icon'
import { DRAWER_ADD_ROW, DRAWER_ROW, DrawerSection, DrawerSectionHeading } from './drawer-section'

interface TaskSubissuesSectionProps {
  subtasks: Task[]
  statuses: Status[]
  onToggleComplete?: (taskId: string) => void
  /** Absent: the list is read-only and an empty list says so in words. */
  onAddSubtask?: (title: string) => void
}

/**
 * The drawer's sub-issue list. Progress sits in the heading (count + bar);
 * adding happens in place on the last row, and Enter keeps the input open so
 * several sub-issues can be typed in a row.
 */
export const TaskSubissuesSection = ({
  subtasks,
  statuses,
  onToggleComplete,
  onAddSubtask
}: TaskSubissuesSectionProps): React.JSX.Element => {
  const { t } = useT('tasks')
  const [isAdding, setIsAdding] = useState(false)
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  const completed = subtasks.filter((s) => s.completedAt !== null).length
  const doneStatus = statuses.find((s) => s.type === 'done')

  const stopAdding = (): void => {
    setIsAdding(false)
    setTitle('')
  }

  return (
    <DrawerSection>
      <DrawerSectionHeading
        count={subtasks.length > 0 ? `${completed}/${subtasks.length}` : undefined}
        trailing={
          subtasks.length > 0 && (
            <div className="h-[3px] w-12 overflow-hidden rounded-full bg-border" aria-hidden="true">
              <div
                className="h-full rounded-full bg-task-complete transition-[width] duration-300"
                style={{ width: `${(completed / subtasks.length) * 100}%` }}
              />
            </div>
          )
        }
      >
        {t('drawer.subIssues')}
      </DrawerSectionHeading>

      {subtasks.map((sub) => {
        const isDone = sub.completedAt !== null
        const status = statuses.find((s) => s.id === sub.statusId)
        const type = isDone ? 'done' : (status?.type ?? 'todo')
        const color = isDone
          ? (doneStatus?.color ?? status?.color ?? 'var(--text-tertiary)')
          : (status?.color ?? 'var(--text-tertiary)')

        return (
          <button
            key={sub.id}
            type="button"
            onClick={() => onToggleComplete?.(sub.id)}
            className={DRAWER_ROW}
          >
            <StatusIcon type={type} color={color} className="size-3.5" />
            <span
              className={cn(
                'min-w-0 truncate',
                isDone
                  ? 'text-text-tertiary line-through decoration-1 [text-underline-position:from-font]'
                  : 'text-text-primary'
              )}
            >
              {sub.title}
            </span>
          </button>
        )
      })}

      {onAddSubtask &&
        (isAdding ? (
          <div className={cn(DRAWER_ROW, 'bg-surface-active/60')}>
            <StatusIcon type="todo" color="var(--text-tertiary)" className="size-3.5" />
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && title.trim()) {
                  onAddSubtask(title.trim())
                  setTitle('')
                }
                if (e.key === 'Escape') {
                  // Keep the drawer's document-level Escape (close drawer)
                  // from firing on the same press.
                  e.stopPropagation()
                  stopAdding()
                }
              }}
              onBlur={() => {
                if (!title.trim()) stopAdding()
              }}
              placeholder={t('drawer.subIssuePlaceholder')}
              aria-label={t('drawer.subIssuePlaceholder')}
              className="min-w-0 flex-1 bg-transparent text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setIsAdding(true)
              requestAnimationFrame(() => inputRef.current?.focus())
            }}
            className={DRAWER_ADD_ROW}
          >
            <Plus className="size-3.5 shrink-0" aria-hidden="true" />
            {t('drawer.addSubIssue')}
          </button>
        ))}

      {!onAddSubtask && subtasks.length === 0 && (
        <span className="px-2 text-[12px] leading-7 text-text-tertiary">
          {t('drawer.noSubIssues')}
        </span>
      )}
    </DrawerSection>
  )
}
