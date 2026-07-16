import { useQuery } from '@tanstack/react-query'
import { useDraggable } from '@dnd-kit/core'
import { useT } from '@memry/i18n/renderer'
import { tasksService, type TaskListItem } from '@/services/tasks-service'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'

const log = createLogger('UnscheduledTasksTab')

function UnscheduledTaskRow({ task }: { task: TaskListItem }): React.JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { type: 'calendar-task', sourceType: 'list', taskId: task.id }
  })

  return (
    <div
      ref={setNodeRef}
      data-testid="unscheduled-task-row"
      data-task-id={task.id}
      className={cn(
        'flex cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-sm touch-none',
        'hover:bg-sidebar-accent',
        isDragging && 'opacity-40'
      )}
      {...attributes}
      {...listeners}
    >
      <span className="min-w-0 truncate text-foreground">{task.title}</span>
    </div>
  )
}

export function UnscheduledTasksTab(): React.JSX.Element {
  const { t } = useT('common')

  const { data: tasks = [] } = useQuery({
    queryKey: ['unscheduled-tasks-tab', 'tasks'],
    queryFn: async (): Promise<TaskListItem[]> => {
      try {
        const result = await tasksService.list({
          unscheduled: true,
          includeCompleted: false,
          includeArchived: false,
          limit: 200
        })
        return result.tasks
      } catch (err) {
        log.error('Failed to fetch unscheduled tasks', err)
        return []
      }
    }
  })

  if (tasks.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{t('agentChat.sidebar.unscheduledEmpty')}</p>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      {tasks.map((task) => (
        <UnscheduledTaskRow key={task.id} task={task} />
      ))}
    </div>
  )
}
