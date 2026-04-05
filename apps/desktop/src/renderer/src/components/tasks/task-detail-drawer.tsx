import { useEffect, useRef, useState, useMemo, memo, useCallback } from 'react'
import { cn } from '@/lib/utils'
import { useDayPanel } from '@/contexts/day-panel-context'
import { type Task, type Priority, type RepeatConfig } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { getSubtasks } from '@/lib/subtask-utils'
import { TaskRepeatSection } from '@/components/tasks/task-repeat-section'
import { notesService } from '@/services/notes-service'
import { InteractiveStatusBadge } from '@/components/tasks/interactive-status-badge'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { InteractiveProjectBadge } from '@/components/tasks/interactive-project-badge'
import { StatusIcon } from '@/components/tasks/status-icon'
import { X, Plus, Trash } from '@/lib/icons'
import { DeleteTaskDialog } from '@/components/tasks/delete-task-dialog'

// ============================================================================
// TYPES
// ============================================================================

export interface TaskDetailDrawerProps {
  task: Task | null
  isOpen: boolean
  onClose: () => void
  tasks: Task[]
  projects: Project[]
  onToggleComplete?: (taskId: string) => void
  onUpdateTask?: (taskId: string, updates: Partial<Task>) => void
  onAddSubtask?: (parentId: string, title: string) => void
  onNoteClick?: (noteId: string) => void
  onDeleteTask?: (taskId: string) => void
}

// ============================================================================
// HELPERS
// ============================================================================

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec'
] as const

const formatCreated = (date: Date): string =>
  `Created ${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`

// ============================================================================
// SMALL DISPLAY COMPONENTS
// ============================================================================

const SectionLabel = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
    {children}
  </span>
)

const NoteIcon = ({ color }: { color: string }): React.JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0"
    style={{ color }}
  >
    <rect x="2" y="1.5" width="10" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.1" />
    <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" stroke="currentColor" strokeLinecap="round" />
  </svg>
)

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export const TaskDetailDrawer = memo(function TaskDetailDrawer({
  task,
  isOpen,
  onClose,
  tasks,
  projects,
  onToggleComplete,
  onUpdateTask,
  onAddSubtask,
  onNoteClick,
  onDeleteTask
}: TaskDetailDrawerProps): React.JSX.Element {
  const { isOpen: isDayPanelOpen, width: dayPanelWidth } = useDayPanel()
  const [noteNames, setNoteNames] = useState<
    Record<string, { title: string; emoji?: string | null }>
  >({})
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isAddingSubtask, setIsAddingSubtask] = useState(false)
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const subtaskInputRef = useRef<HTMLInputElement>(null)

  const [isLinkingNote, setIsLinkingNote] = useState(false)
  const [noteSearchQuery, setNoteSearchQuery] = useState('')
  const [availableNotes, setAvailableNotes] = useState<
    Array<{ id: string; title: string; emoji?: string | null }>
  >([])
  const noteSearchInputRef = useRef<HTMLInputElement>(null)

  const linkedNoteKey = task?.linkedNoteIds?.join(',') ?? ''

  useEffect(() => {
    if (!task?.linkedNoteIds?.length) {
      setNoteNames({})
      return
    }
    let cancelled = false
    Promise.all(
      task.linkedNoteIds.map(async (id) => {
        try {
          const note = await notesService.get(id)
          return note ? ([id, { title: note.title, emoji: note.emoji }] as const) : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) return
      const names: Record<string, { title: string; emoji?: string | null }> = {}
      for (const r of results) if (r) names[r[0]] = r[1]
      setNoteNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [task?.id, linkedNoteKey])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (isAddingSubtask) {
          setIsAddingSubtask(false)
          setNewSubtaskTitle('')
        } else if (isLinkingNote) {
          setIsLinkingNote(false)
          setNoteSearchQuery('')
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, isAddingSubtask, isLinkingNote])

  const handleStartAddSubtask = useCallback(() => {
    setIsAddingSubtask(true)
    requestAnimationFrame(() => subtaskInputRef.current?.focus())
  }, [])

  const handleStartLinkNote = useCallback(() => {
    setIsLinkingNote(true)
    requestAnimationFrame(() => noteSearchInputRef.current?.focus())
    notesService.list({ sortBy: 'modified', sortOrder: 'desc', limit: 50 }).then((res) => {
      setAvailableNotes(res.notes.map((n) => ({ id: n.id, title: n.title, emoji: n.emoji })))
    })
  }, [])

  const project = useMemo(
    () => (task ? (projects.find((p) => p.id === task.projectId) ?? null) : null),
    [task?.projectId, projects]
  )

  const subtasks = useMemo(() => (task ? getSubtasks(task.id, tasks) : []), [task?.id, tasks])

  const completedSubtaskCount = useMemo(
    () => subtasks.filter((s) => s.completedAt !== null).length,
    [subtasks]
  )

  const filteredSearchNotes = useMemo(() => {
    if (!isLinkingNote || !task) return []
    const linked = new Set(task.linkedNoteIds)
    const q = noteSearchQuery.toLowerCase()
    return availableNotes.filter((n) => !linked.has(n.id) && n.title.toLowerCase().includes(q))
  }, [isLinkingNote, task?.linkedNoteIds, noteSearchQuery, availableNotes])

  const handleStatusChange = useCallback(
    (statusId: string) => {
      if (task) onUpdateTask?.(task.id, { statusId })
    },
    [task?.id, onUpdateTask]
  )

  const handlePriorityChange = useCallback(
    (priority: Priority) => {
      if (task) onUpdateTask?.(task.id, { priority })
    },
    [task?.id, onUpdateTask]
  )

  const handleDueDateChange = useCallback(
    (dueDate: Date | null) => {
      if (task) onUpdateTask?.(task.id, { dueDate })
    },
    [task?.id, onUpdateTask]
  )

  const handleDueTimeChange = useCallback(
    (dueTime: string | null) => {
      if (task) onUpdateTask?.(task.id, { dueTime })
    },
    [task?.id, onUpdateTask]
  )

  const handleProjectChange = useCallback(
    (projectId: string) => {
      if (task) onUpdateTask?.(task.id, { projectId })
    },
    [task?.id, onUpdateTask]
  )

  const handleRepeatChange = useCallback(
    (repeatConfig: RepeatConfig | null) => {
      if (!task) return
      onUpdateTask?.(task.id, {
        repeatConfig,
        isRepeating: repeatConfig !== null
      })
    },
    [task?.id, onUpdateTask]
  )

  return (
    <div
      role="complementary"
      aria-label="Task details"
      aria-hidden={!isOpen}
      className={cn(
        'fixed top-[37px] bottom-0 z-10 border-l bg-surface overflow-hidden',
        'transition-[width,opacity,right] duration-200 ease-out',
        isOpen ? 'w-[380px] opacity-100 border-border' : 'w-0 opacity-0 border-transparent'
      )}
      style={{ right: isDayPanelOpen ? `${dayPanelWidth}px` : 0 }}
    >
      <div className="w-[380px] h-full flex flex-col overflow-y-auto scrollbar-thin [font-synthesis:none] text-[12px] leading-4">
        {task && project && (
          <>
            {/* ── Header: editable title + close ── */}
            <div className="flex items-center gap-2 shrink-0 py-3.5 px-5 border-b border-border">
              <input
                type="text"
                value={task.title}
                onChange={(e) => onUpdateTask?.(task.id, { title: e.target.value })}
                className="flex-1 min-w-0 text-[14px] font-medium text-text-primary bg-transparent outline-none truncate"
                placeholder="Task name"
              />
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none"
                aria-label="Close task details"
              >
                <X size={16} />
              </button>
            </div>

            {/* ── Properties Grid ── */}
            <div className="flex flex-col pt-3 pb-4 border-b border-border px-5">
              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Status
                </span>
                <InteractiveStatusBadge
                  statusId={task.statusId}
                  statuses={project.statuses}
                  onStatusChange={handleStatusChange}
                />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Priority
                </span>
                <InteractivePriorityBadge
                  priority={task.priority}
                  onPriorityChange={handlePriorityChange}
                  compact
                />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Due date
                </span>
                <InteractiveDueDateBadge
                  dueDate={task.dueDate}
                  dueTime={task.dueTime}
                  onDateChange={handleDueDateChange}
                  onTimeChange={handleDueTimeChange}
                  isRepeating={task.isRepeating}
                />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Project
                </span>
                <InteractiveProjectBadge
                  projectId={task.projectId}
                  projects={projects}
                  onProjectChange={handleProjectChange}
                />
              </div>
            </div>

            {/* ── Description ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <SectionLabel>Description</SectionLabel>
              <textarea
                value={task.description ?? ''}
                onChange={(e) => onUpdateTask?.(task.id, { description: e.target.value })}
                placeholder="Add a description..."
                rows={3}
                className="text-[13px] leading-5 text-text-secondary bg-transparent outline-none resize-none placeholder:text-text-tertiary"
              />
            </div>

            {/* ── Sub-issues ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <div className="flex items-center justify-between">
                <SectionLabel>Sub-issues</SectionLabel>
                <div className="flex items-center gap-1.5">
                  {subtasks.length > 0 && (
                    <span className="text-[11px] text-text-tertiary leading-3.5">
                      {completedSubtaskCount} / {subtasks.length}
                    </span>
                  )}
                  {onAddSubtask && (
                    <button
                      type="button"
                      onClick={handleStartAddSubtask}
                      className="text-text-tertiary hover:text-text-secondary transition-colors"
                      aria-label="Add sub-issue"
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
              </div>
              {subtasks.map((sub) => {
                const isDone = sub.completedAt !== null
                const subStatus = project.statuses.find((s) => s.id === sub.statusId)
                const doneStatus = project.statuses.find((s) => s.type === 'done')
                const subType = isDone
                  ? 'done'
                  : ((subStatus?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
                const subColor = isDone
                  ? (doneStatus?.color ?? subStatus?.color ?? 'var(--text-tertiary)')
                  : (subStatus?.color ?? 'var(--text-tertiary)')

                return (
                  <button
                    key={sub.id}
                    type="button"
                    onClick={() => onToggleComplete?.(sub.id)}
                    className="flex items-center py-1 gap-2 text-left"
                  >
                    <StatusIcon type={subType} color={subColor} />
                    <span
                      className={cn(
                        'text-[12px] leading-4',
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
              {isAddingSubtask && (
                <div className="flex items-center py-1 gap-2">
                  <StatusIcon type="todo" color="var(--text-tertiary)" />
                  <input
                    ref={subtaskInputRef}
                    type="text"
                    value={newSubtaskTitle}
                    onChange={(e) => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && newSubtaskTitle.trim()) {
                        onAddSubtask?.(task.id, newSubtaskTitle.trim())
                        setNewSubtaskTitle('')
                      }
                      if (e.key === 'Escape') {
                        setIsAddingSubtask(false)
                        setNewSubtaskTitle('')
                      }
                    }}
                    onBlur={() => {
                      if (!newSubtaskTitle.trim()) {
                        setIsAddingSubtask(false)
                        setNewSubtaskTitle('')
                      }
                    }}
                    placeholder="Add sub-issue…"
                    className="flex-1 text-[12px] leading-4 text-text-primary placeholder:text-text-tertiary bg-transparent outline-none"
                  />
                </div>
              )}
              {subtasks.length === 0 && !isAddingSubtask && (
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  No sub-issues yet
                </span>
              )}
            </div>

            {/* ── Repeat ── */}
            <TaskRepeatSection
              taskTitle={task.title}
              repeatConfig={task.repeatConfig}
              isRepeating={task.isRepeating}
              dueDate={task.dueDate}
              projectColor={project.color}
              onRepeatChange={handleRepeatChange}
            />

            {/* ── Linked Notes ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <div className="flex items-center justify-between">
                <SectionLabel>Linked Notes</SectionLabel>
                <button
                  type="button"
                  onClick={handleStartLinkNote}
                  className="text-text-tertiary hover:text-text-secondary transition-colors"
                  aria-label="Link a note"
                >
                  <Plus size={14} />
                </button>
              </div>
              {task.linkedNoteIds.map((noteId) => {
                const info = noteNames[noteId]
                return (
                  <div
                    key={noteId}
                    className="group flex items-center rounded-md py-1.5 px-2.5 gap-2 bg-foreground/[0.03] hover:bg-foreground/[0.05] transition-colors cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => onNoteClick?.(noteId)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onNoteClick?.(noteId)
                      }
                    }}
                  >
                    {info?.emoji ? (
                      <span className="size-3.5 text-center text-[13px] leading-3.5 shrink-0">
                        {info.emoji}
                      </span>
                    ) : (
                      <NoteIcon color={project.color} />
                    )}
                    <span className="flex-1 min-w-0 text-[12px] text-text-secondary leading-4 truncate">
                      {info?.title ?? 'Loading…'}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onUpdateTask?.(task.id, {
                          linkedNoteIds: task.linkedNoteIds.filter((id) => id !== noteId)
                        })
                        setNoteNames((prev) => {
                          const next = { ...prev }
                          delete next[noteId]
                          return next
                        })
                      }}
                      className="shrink-0 rounded-sm p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-secondary transition-all"
                      aria-label={`Remove link to ${info?.title ?? 'note'}`}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
              {isLinkingNote && (
                <div className="flex flex-col gap-1">
                  <input
                    ref={noteSearchInputRef}
                    type="text"
                    value={noteSearchQuery}
                    onChange={(e) => setNoteSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        setIsLinkingNote(false)
                        setNoteSearchQuery('')
                      }
                    }}
                    placeholder="Search notes…"
                    className="text-[12px] leading-4 text-text-primary placeholder:text-text-tertiary bg-foreground/[0.03] rounded-md py-1.5 px-2.5 outline-none border border-border focus:border-ring"
                  />
                  <div className="max-h-[160px] overflow-y-auto scrollbar-thin flex flex-col gap-0.5">
                    {filteredSearchNotes.map((note) => (
                      <button
                        key={note.id}
                        type="button"
                        onClick={() => {
                          onUpdateTask?.(task.id, {
                            linkedNoteIds: [...task.linkedNoteIds, note.id]
                          })
                          setNoteNames((prev) => ({
                            ...prev,
                            [note.id]: { title: note.title, emoji: note.emoji }
                          }))
                          setNoteSearchQuery('')
                          setIsLinkingNote(false)
                        }}
                        className="flex items-center rounded-md py-1.5 px-2.5 gap-2 text-left hover:bg-foreground/[0.05] transition-colors"
                      >
                        {note.emoji ? (
                          <span className="size-3.5 text-center text-[13px] leading-3.5 shrink-0">
                            {note.emoji}
                          </span>
                        ) : (
                          <NoteIcon color={project.color} />
                        )}
                        <span className="text-[12px] text-text-secondary leading-4 truncate">
                          {note.title}
                        </span>
                      </button>
                    ))}
                    {filteredSearchNotes.length === 0 && (
                      <span className="text-[11px] text-text-tertiary leading-3.5 py-1.5 px-2.5">
                        {noteSearchQuery ? 'No matching notes' : 'No notes available'}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {task.linkedNoteIds.length === 0 && !isLinkingNote && (
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  No linked notes yet
                </span>
              )}
            </div>

            {/* ── Footer ── */}
            <div className="flex flex-col py-3 px-5 gap-3 mt-auto">
              {onDeleteTask && (
                <button
                  type="button"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  className="flex items-center gap-2 py-1.5 px-2.5 rounded-md text-[12px] leading-4 text-destructive hover:bg-destructive/10 transition-colors w-full"
                  aria-label="Delete task"
                >
                  <Trash size={14} />
                  Delete task
                </button>
              )}
              <span className="text-[11px] text-text-tertiary/60 leading-3.5">
                {formatCreated(task.createdAt)}
              </span>
            </div>

            {onDeleteTask && (
              <DeleteTaskDialog
                isOpen={isDeleteDialogOpen}
                onClose={() => setIsDeleteDialogOpen(false)}
                onConfirm={() => onDeleteTask(task.id)}
                taskTitle={task.title}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
})
