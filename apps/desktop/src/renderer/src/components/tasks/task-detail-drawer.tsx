import { useEffect, useRef, useState, useMemo, memo } from 'react'
import { cn } from '@/lib/utils'
import { PriorityBars } from '@/components/tasks/task-icons'
import { priorityConfig, type Task, type RepeatConfig } from '@/data/sample-tasks'
import type { Project } from '@/data/tasks-data'
import { formatDateShort } from '@/lib/task-utils'
import { getSubtasks } from '@/lib/subtask-utils'
import { getRepeatDisplayText } from '@/lib/repeat-utils'
import { notesService } from '@/services/notes-service'

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
  onEditRepeat?: (taskId: string) => void
  onStopRepeating?: (taskId: string) => void
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

const getOverdueInfo = (dueDate: Date): { days: number; text: string } | null => {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(dueDate)
  due.setHours(0, 0, 0, 0)
  const diff = Math.floor((today.getTime() - due.getTime()) / 86400000)
  if (diff <= 0) return null
  return { days: diff, text: diff === 1 ? '1 day overdue' : `${diff} days overdue` }
}

const buildRepeatInfoLine = (config: RepeatConfig): string => {
  const parts = ['From: Due date']
  if (config.endType === 'never') parts.push('Ends: Never')
  else if (config.endType === 'date' && config.endDate)
    parts.push(`Ends: ${formatDateShort(config.endDate)}`)
  else if (config.endType === 'count' && config.endCount)
    parts.push(`Ends: After ${config.endCount}x`)
  parts.push(`Done: ${config.completedCount}x`)
  return parts.join(' | ')
}

// ============================================================================
// SMALL DISPLAY COMPONENTS
// ============================================================================

const SectionLabel = ({ children }: { children: React.ReactNode }): React.JSX.Element => (
  <span className="text-[11px] [letter-spacing:0.05em] uppercase text-text-tertiary font-medium leading-3.5">
    {children}
  </span>
)

const StatusIcon = ({
  type,
  color
}: {
  type: 'todo' | 'in_progress' | 'done'
  color: string
}): React.JSX.Element => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
    {type === 'done' ? (
      <>
        <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.2" fill={color} />
        <path
          d="M4.5 7l1.5 1.5L9.5 5.5"
          stroke="var(--background)"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </>
    ) : type === 'in_progress' ? (
      <>
        <circle cx="7" cy="7" r="4.5" stroke={color} strokeWidth="1.3" />
        <path d="M7 2.5A4.5 4.5 0 0 1 7 11.5" fill={color} />
      </>
    ) : (
      <circle cx="7" cy="7" r="4.5" stroke="var(--text-tertiary)" strokeWidth="1.2" />
    )}
  </svg>
)

const CalendarIcon = ({ overdue }: { overdue: boolean }): React.JSX.Element => {
  const stroke = overdue ? 'var(--destructive)' : 'var(--text-tertiary)'
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
      <rect x="1.5" y="2.5" width="11" height="10" rx="1.5" stroke={stroke} strokeWidth="1.2" />
      <path d="M1.5 5.5h11" stroke={stroke} strokeWidth="1.2" />
      <path d="M4.5 1v2M9.5 1v2" stroke={stroke} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

const RepeatIcon = ({ color }: { color: string }): React.JSX.Element => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 14 14"
    fill="none"
    className="shrink-0"
    style={{ color }}
  >
    <path
      d="M2 7a5 5 0 0 1 9-3M12 7a5 5 0 0 1-9 3"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
    />
    <path
      d="M11 2v2.5h-2.5M3 12V9.5h2.5"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
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
  onEditRepeat,
  onStopRepeating
}: TaskDetailDrawerProps): React.JSX.Element {
  const [noteNames, setNoteNames] = useState<Record<string, string>>({})
  const [isAddingSubtask, setIsAddingSubtask] = useState(false)
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const subtaskInputRef = useRef<HTMLInputElement>(null)

  const [isLinkingNote, setIsLinkingNote] = useState(false)
  const [noteSearchQuery, setNoteSearchQuery] = useState('')
  const [availableNotes, setAvailableNotes] = useState<Array<{ id: string; title: string }>>([])
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
          return note ? ([id, note.title] as const) : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) return
      const names: Record<string, string> = {}
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

  useEffect(() => {
    if (isAddingSubtask) subtaskInputRef.current?.focus()
  }, [isAddingSubtask])

  useEffect(() => {
    if (isLinkingNote) {
      noteSearchInputRef.current?.focus()
      notesService.list({ sortBy: 'modified', sortOrder: 'desc', limit: 50 }).then((res) => {
        setAvailableNotes(res.notes.map((n) => ({ id: n.id, title: n.title })))
      })
    }
  }, [isLinkingNote])

  useEffect(() => {
    setIsAddingSubtask(false)
    setNewSubtaskTitle('')
    setIsLinkingNote(false)
    setNoteSearchQuery('')
  }, [task?.id])

  const project = useMemo(
    () => (task ? (projects.find((p) => p.id === task.projectId) ?? null) : null),
    [task?.projectId, projects]
  )

  const status = useMemo(
    () => (task && project ? (project.statuses.find((s) => s.id === task.statusId) ?? null) : null),
    [task?.statusId, project]
  )

  const statusType = (status?.type ?? 'todo') as 'todo' | 'in_progress' | 'done'
  const statusColor = status?.color ?? 'var(--text-tertiary)'
  const isCompleted = task ? task.completedAt !== null : false

  const subtasks = useMemo(() => (task ? getSubtasks(task.id, tasks) : []), [task?.id, tasks])

  const completedSubtaskCount = useMemo(
    () => subtasks.filter((s) => s.completedAt !== null).length,
    [subtasks]
  )

  const overdue = useMemo(
    () => (task?.dueDate && !isCompleted ? getOverdueInfo(task.dueDate) : null),
    [task?.dueDate, isCompleted]
  )

  const priorityInfo = task ? priorityConfig[task.priority] : null

  const filteredSearchNotes = useMemo(() => {
    if (!isLinkingNote || !task) return []
    const linked = new Set(task.linkedNoteIds)
    const q = noteSearchQuery.toLowerCase()
    return availableNotes.filter((n) => !linked.has(n.id) && n.title.toLowerCase().includes(q))
  }, [isLinkingNote, task?.linkedNoteIds, noteSearchQuery, availableNotes])

  return (
    <div
      role="complementary"
      aria-label="Task details"
      aria-hidden={!isOpen}
      className={cn(
        'shrink-0 h-full border-l bg-surface overflow-hidden',
        'transition-[width,opacity] duration-200 ease-out',
        isOpen ? 'w-[380px] opacity-100 border-border' : 'w-0 opacity-0 border-transparent'
      )}
    >
      <div className="w-[380px] h-full flex flex-col overflow-y-auto scrollbar-thin [font-synthesis:none] text-[12px] leading-4 antialiased">
        {task && project && (
          <>
            {/* ── Header ── */}
            <div className="flex items-center justify-between shrink-0 py-3.5 px-5 border-b border-border">
              <div className="flex items-center gap-1">
                <div
                  className="rounded-xs shrink-0 size-2"
                  style={{ backgroundColor: project.color }}
                />
                <span className="text-[12px] text-text-tertiary leading-4">{project.name}</span>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Close task details"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M4 4l8 8M12 4l-8 8"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {/* ── Title ── */}
            <div className="pt-5 pb-4 shrink-0 text-[16px] text-text-primary font-sans leading-5 px-5">
              {task.title}
            </div>

            {/* ── Properties Grid ── */}
            <div className="flex flex-col pb-4 border-b border-border px-5">
              {/* Status */}
              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Status
                </span>
                <div className="flex items-center gap-1.5">
                  <StatusIcon type={isCompleted ? 'done' : statusType} color={statusColor} />
                  <span className="text-[12px] text-text-primary leading-4">
                    {status?.name ?? 'Unknown'}
                  </span>
                </div>
              </div>

              {/* Priority (hidden when none) */}
              {task.priority !== 'none' && priorityInfo?.label && (
                <div className="flex items-center py-1.5">
                  <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                    Priority
                  </span>
                  <div className="flex items-center gap-1.5">
                    <PriorityBars priority={task.priority} />
                    <span
                      className="text-[12px] leading-4"
                      style={{ color: priorityInfo.color ?? undefined }}
                    >
                      {priorityInfo.label}
                    </span>
                  </div>
                </div>
              )}

              {/* Due date */}
              {task.dueDate && (
                <div className="flex items-center py-1.5">
                  <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                    Due date
                  </span>
                  <div className="flex items-center gap-1.5">
                    <CalendarIcon overdue={!!overdue} />
                    <span
                      className={cn(
                        'text-[12px] leading-4',
                        overdue ? 'text-destructive' : 'text-text-primary'
                      )}
                    >
                      {formatDateShort(task.dueDate)}
                      {overdue && ` — ${overdue.text}`}
                    </span>
                  </div>
                </div>
              )}

              {/* Project chip */}
              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  Project
                </span>
                <div
                  className="flex items-center rounded-full py-0.5 px-2 border"
                  style={{ borderColor: `${project.color}4D` }}
                >
                  <span className="text-[11px] leading-3.5" style={{ color: project.color }}>
                    {project.name}
                  </span>
                </div>
              </div>
            </div>

            {/* ── Description ── */}
            {task.description && (
              <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
                <SectionLabel>Description</SectionLabel>
                <p className="text-[13px] leading-5 text-text-secondary whitespace-pre-wrap">
                  {task.description}
                </p>
              </div>
            )}

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
                      onClick={() => setIsAddingSubtask(true)}
                      className="text-text-tertiary hover:text-text-secondary transition-colors"
                      aria-label="Add sub-issue"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                        <path
                          d="M7 3v8M3 7h8"
                          stroke="currentColor"
                          strokeWidth="1.2"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  )}
                </div>
              </div>
              {subtasks.map((sub) => {
                const isDone = sub.completedAt !== null
                const subStatus = project.statuses.find((s) => s.id === sub.statusId)
                const subType = isDone
                  ? 'done'
                  : ((subStatus?.type ?? 'todo') as 'todo' | 'in_progress' | 'done')
                const subColor = subStatus?.color ?? 'var(--text-tertiary)'

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
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="shrink-0">
                    <circle cx="7" cy="7" r="4.5" stroke="var(--text-tertiary)" strokeWidth="1.2" />
                  </svg>
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
            {task.isRepeating && task.repeatConfig && (
              <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
                <div className="flex items-center justify-between">
                  <SectionLabel>Repeat</SectionLabel>
                  <RepeatIcon color="var(--text-tertiary)" />
                </div>
                <div className="flex items-center rounded-md py-2 px-2.5 gap-2 bg-foreground/[0.03]">
                  <RepeatIcon color={project.color} />
                  <div className="flex flex-col gap-0.5">
                    <span className="text-[12px] text-text-primary font-medium leading-4">
                      {getRepeatDisplayText(task.repeatConfig)}
                    </span>
                    <span className="text-[11px] text-text-tertiary leading-3.5">
                      {buildRepeatInfoLine(task.repeatConfig)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {onEditRepeat && (
                    <button
                      type="button"
                      onClick={() => onEditRepeat(task.id)}
                      className="flex items-center rounded-[5px] py-1 px-2.5 border border-foreground/10"
                    >
                      <span className="text-[11px] text-text-primary font-medium leading-3.5">
                        Edit
                      </span>
                    </button>
                  )}
                  {onStopRepeating && (
                    <button
                      type="button"
                      onClick={() => onStopRepeating(task.id)}
                      className="flex items-center rounded-[5px] py-1 px-2.5 border border-foreground/10"
                    >
                      <span className="text-[11px] text-text-primary font-medium leading-3.5">
                        Stop repeating
                      </span>
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ── Linked Notes ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <div className="flex items-center justify-between">
                <SectionLabel>Linked Notes</SectionLabel>
                <button
                  type="button"
                  onClick={() => setIsLinkingNote(true)}
                  className="text-text-tertiary hover:text-text-secondary transition-colors"
                  aria-label="Link a note"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path
                      d="M7 3v8M3 7h8"
                      stroke="currentColor"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              {task.linkedNoteIds.map((noteId) => (
                <div
                  key={noteId}
                  className="flex items-center rounded-md py-1.5 px-2.5 gap-2 bg-foreground/[0.03]"
                >
                  <NoteIcon color={project.color} />
                  <span className="text-[12px] text-text-secondary leading-4 truncate">
                    {noteNames[noteId] ?? 'Loading…'}
                  </span>
                </div>
              ))}
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
                          setNoteNames((prev) => ({ ...prev, [note.id]: note.title }))
                          setNoteSearchQuery('')
                          setIsLinkingNote(false)
                        }}
                        className="flex items-center rounded-md py-1.5 px-2.5 gap-2 text-left hover:bg-foreground/[0.05] transition-colors"
                      >
                        <NoteIcon color={project.color} />
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
            <div className="flex flex-col py-3 px-5 gap-1 mt-auto">
              <span className="text-[11px] text-text-tertiary/60 leading-3.5">
                {formatCreated(task.createdAt)}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
})
