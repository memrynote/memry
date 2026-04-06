import { type FC, useState, useCallback, useEffect, useRef, type RefObject } from 'react'
import { Popover, PopoverContent, PopoverAnchor } from '@/components/ui/popover'
import { Button } from '@/components/ui/button'
import { useTasksOptional } from '@/contexts/tasks'
import { tasksService, type TaskCreateInput } from '@/services/tasks-service'
import { extractErrorMessage } from '@/lib/ipc-error'
import { cn } from '@/lib/utils'

interface TaskCreationPopoverProps {
  isOpen: boolean
  anchorRef: RefObject<HTMLElement | null>
  title: string
  noteId?: string
  onCreated: (taskId: string, title: string) => void
  onCancel: () => void
}

const PRIORITY_OPTIONS = [
  { value: 0, label: 'None', color: 'bg-stone-300 dark:bg-stone-600' },
  { value: 1, label: 'Low', color: 'bg-sky-400' },
  { value: 2, label: 'Medium', color: 'bg-amber-400' },
  { value: 3, label: 'High', color: 'bg-orange-500' },
  { value: 4, label: 'Urgent', color: 'bg-red-500' }
] as const

export const TaskCreationPopover: FC<TaskCreationPopoverProps> = ({
  isOpen,
  anchorRef,
  title,
  noteId,
  onCreated,
  onCancel
}) => {
  const tasksCtx = useTasksOptional()
  const projects = tasksCtx?.projects?.filter((p) => !p.isArchived) ?? []
  const inboxProject = projects.find((p) => p.isDefault)

  const [projectId, setProjectId] = useState('')
  const [priority, setPriority] = useState(0)
  const [dueDate, setDueDate] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const createBtnRef = useRef<HTMLButtonElement>(null)
  const prevOpenRef = useRef(false)

  useEffect(() => {
    const justOpened = isOpen && !prevOpenRef.current
    prevOpenRef.current = isOpen
    if (justOpened) {
      setProjectId(inboxProject?.id ?? projects[0]?.id ?? '')
      setPriority(0)
      setDueDate('')
      setError(null)
      setIsSubmitting(false)
    }
  }, [isOpen, inboxProject?.id, projects])

  const handleCreate = useCallback(async () => {
    if (!projectId || isSubmitting) return
    setIsSubmitting(true)
    setError(null)

    const input: TaskCreateInput = {
      projectId,
      title,
      priority,
      dueDate: dueDate || null,
      linkedNoteIds: noteId ? [noteId] : []
    }

    try {
      const res = await tasksService.create(input)
      if (res.success && res.task) {
        onCreated(res.task.id, res.task.title)
      } else {
        setError(res.error ?? 'Failed to create task')
        setIsSubmitting(false)
      }
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to create task'))
      setIsSubmitting(false)
    }
  }, [projectId, title, priority, dueDate, noteId, isSubmitting, onCreated])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault()
        handleCreate()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        onCancel()
      }
    },
    [handleCreate, onCancel]
  )

  return (
    <Popover open={isOpen} onOpenChange={(open) => !open && onCancel()}>
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        className="w-72 p-3"
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          createBtnRef.current?.focus()
        }}
      >
        <div className="space-y-3">
          <div className="truncate text-sm font-medium">{title}</div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Project</label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={cn(
                'w-full rounded-md border bg-transparent px-2 py-1.5 text-sm',
                'focus:outline-none focus:ring-1 focus:ring-ring'
              )}
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Priority</label>
            <div className="flex items-center gap-1.5">
              {PRIORITY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPriority(opt.value)}
                  title={opt.label}
                  className={cn(
                    'size-5 rounded-full transition-all',
                    opt.color,
                    priority === opt.value
                      ? 'ring-2 ring-ring ring-offset-1 ring-offset-background scale-110'
                      : 'opacity-50 hover:opacity-80'
                  )}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Due date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className={cn(
                'w-full rounded-md border bg-transparent px-2 py-1.5 text-sm',
                'focus:outline-none focus:ring-1 focus:ring-ring'
              )}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex items-center justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={onCancel} disabled={isSubmitting}>
              Cancel
            </Button>
            <Button
              ref={createBtnRef}
              size="sm"
              onClick={handleCreate}
              disabled={!projectId || isSubmitting}
            >
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
