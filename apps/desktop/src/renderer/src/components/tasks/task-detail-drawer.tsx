import { useEffect, useRef, useState, useMemo, memo, useCallback } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { createLogger } from '@/lib/logger'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useResizablePanel } from '@/hooks/use-resizable-panel'
import { PanelResizeRail } from '@/components/ui/panel-resize-rail'
import { type Task, type Priority, type RepeatConfig } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getSubtasks } from '@/lib/subtask-utils'
import { TaskRepeatSection } from '@/components/tasks/task-repeat-section'
import { notesService } from '@/services/notes-service'
import { canvasService } from '@/services/canvas-service'
import { NoteIconDisplay } from '@/lib/render-note-icon'
import {
  useRelatedItemSearch,
  type RelatedSearchItem
} from '@/components/tasks/use-related-item-search'
import { InteractiveStatusBadge } from '@/components/tasks/interactive-status-badge'
import { InteractivePriorityBadge } from '@/components/tasks/interactive-priority-badge'
import { InteractiveDueDateBadge } from '@/components/tasks/interactive-due-date-badge'
import { InteractiveProjectBadge } from '@/components/tasks/interactive-project-badge'
import { TaskDescriptionEditor } from '@/components/tasks/task-description-editor'
import { TagAutocomplete } from '@/components/filing/tag-autocomplete'
import { TaskReminderButton } from '@/components/tasks/task-reminder-button'
import { StatusIcon } from '@/components/tasks/status-icon'
import { FileAudio, FileImage, FilePdf, FileVideo, PenTool, X, Plus, Trash } from '@/lib/icons'
import { DeleteTaskDialog } from '@/components/tasks/delete-task-dialog'
import { TaskActivitySection } from '@/components/tasks/task-activity-section'
import type { FileType } from '@memry/shared/file-types'

const log = createLogger('TaskDetailDrawer')

const TASK_DETAIL_WIDTH_KEY = 'task-detail-width'
const TASK_DETAIL_WIDTH_DEFAULT_PX = 266
const TASK_DETAIL_WIDTH_MIN_PX = 240
const TASK_DETAIL_WIDTH_MAX_PX = 480

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
  onCanvasClick?: (canvasId: string, title: string | null) => void
  onDeleteTask?: (taskId: string) => void
}

// ============================================================================
// HELPERS
// ============================================================================

const formatCreatedDate = (date: Date, language: string): string =>
  new Intl.DateTimeFormat(language, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date)

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

const RelatedItemIcon = ({
  fileType,
  color
}: {
  fileType: FileType
  color: string
}): React.JSX.Element => {
  const className = 'size-3.5 shrink-0 text-text-tertiary'

  switch (fileType) {
    case 'pdf':
      return <FilePdf className={className} aria-hidden="true" />
    case 'image':
      return <FileImage className={className} aria-hidden="true" />
    case 'audio':
      return <FileAudio className={className} aria-hidden="true" />
    case 'video':
      return <FileVideo className={className} aria-hidden="true" />
    case 'markdown':
      return <NoteIcon color={color} />
  }
}

// A note and a canvas can carry the same id, so a related item is addressed by
// a discriminated reference rather than a bare id. Storage stays two disjoint
// fields; only this layer unions them.
type RelatedRef = { kind: 'note'; id: string } | { kind: 'canvas'; id: string }

type RelatedItemInfo =
  | { kind: 'note'; title: string; emoji?: string | null; fileType: FileType }
  | { kind: 'canvas'; title: string; icon: string | null }

const RelatedIcon = ({
  kind,
  info,
  projectColor
}: {
  kind: RelatedRef['kind']
  info?: RelatedItemInfo
  projectColor: string
}): React.JSX.Element => {
  if (kind === 'canvas') {
    const icon = info?.kind === 'canvas' ? info.icon : null
    return icon ? (
      <NoteIconDisplay value={icon} className="size-3.5 shrink-0 text-[13px] leading-3.5" />
    ) : (
      <PenTool className="size-3.5 shrink-0 text-text-tertiary" aria-hidden="true" />
    )
  }
  const emoji = info?.kind === 'note' ? info.emoji : null
  return emoji ? (
    <span className="size-3.5 text-center text-[13px] leading-3.5 shrink-0">{emoji}</span>
  ) : (
    <RelatedItemIcon
      fileType={info?.kind === 'note' ? info.fileType : 'markdown'}
      color={projectColor}
    />
  )
}

type RelatedItemKey = `${RelatedRef['kind']}:${string}`
type RelatedItemInfoByKey = Partial<Record<RelatedItemKey, RelatedItemInfo>>

const relatedItemKey = (ref: RelatedRef): RelatedItemKey => `${ref.kind}:${ref.id}`

const EMPTY_RELATED_ITEMS: RelatedItemInfoByKey = {}

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
  onCanvasClick,
  onDeleteTask
}: TaskDetailDrawerProps): React.JSX.Element {
  const { t, i18n } = useT('tasks')
  const { t: tCommon } = useT('common')
  const prefersReducedMotion = useReducedMotion()
  const { width, setWidth, setIsResizing } = useResizablePanel({
    storageKey: TASK_DETAIL_WIDTH_KEY,
    defaultPx: TASK_DETAIL_WIDTH_DEFAULT_PX,
    minPx: TASK_DETAIL_WIDTH_MIN_PX,
    maxPx: TASK_DETAIL_WIDTH_MAX_PX
  })
  const [noteNames, setNoteNames] = useState<RelatedItemInfoByKey>({})
  const [canvasNames, setCanvasNames] = useState<RelatedItemInfoByKey>({})
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)
  const [isAddingSubtask, setIsAddingSubtask] = useState(false)
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const subtaskInputRef = useRef<HTMLInputElement>(null)

  const [isLinkingNote, setIsLinkingNote] = useState(false)
  const [noteSearchQuery, setNoteSearchQuery] = useState('')
  const noteSearchInputRef = useRef<HTMLInputElement>(null)

  const untitledCanvasLabel = tCommon('canvas.untitled')
  const linkedNoteKey = task?.linkedNoteIds?.join(',') ?? ''
  const linkedCanvasKey = task?.linkedCanvasIds?.join(',') ?? ''

  const relatedRefs = useMemo<RelatedRef[]>(
    () => [
      ...(task?.linkedNoteIds ?? []).map((id): RelatedRef => ({ kind: 'note', id })),
      ...(task?.linkedCanvasIds ?? []).map((id): RelatedRef => ({ kind: 'canvas', id }))
    ],
    [task?.linkedNoteIds, task?.linkedCanvasIds]
  )

  const displayedRelatedNames = useMemo(
    () => (relatedRefs.length ? { ...noteNames, ...canvasNames } : EMPTY_RELATED_ITEMS),
    [relatedRefs.length, noteNames, canvasNames]
  )

  useEffect(() => {
    if (!task?.linkedNoteIds?.length) {
      return
    }
    let cancelled = false
    void Promise.all(
      task.linkedNoteIds.map(async (id) => {
        try {
          const file = await notesService.getFile(id)
          if (file) {
            return [
              relatedItemKey({ kind: 'note', id }),
              { kind: 'note' as const, title: file.title, emoji: null, fileType: file.fileType }
            ] as const
          }

          const note = await notesService.get(id)
          return note
            ? ([
                relatedItemKey({ kind: 'note', id }),
                {
                  kind: 'note' as const,
                  title: note.title,
                  emoji: note.emoji,
                  fileType: 'markdown' as const
                }
              ] as const)
            : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (cancelled) return
      const names: RelatedItemInfoByKey = {}
      for (const r of results) if (r) names[r[0]] = r[1]
      setNoteNames(names)
    })
    return () => {
      cancelled = true
    }
  }, [task?.id, linkedNoteKey, task?.linkedNoteIds])

  useEffect(() => {
    if (!task?.linkedCanvasIds?.length) {
      return
    }
    let cancelled = false
    const linked = new Set(task.linkedCanvasIds)
    void canvasService.list().then(
      (response) => {
        if (cancelled) return
        const names: RelatedItemInfoByKey = {}
        for (const canvas of response.canvases) {
          if (!linked.has(canvas.id)) continue
          names[relatedItemKey({ kind: 'canvas', id: canvas.id })] = {
            kind: 'canvas',
            title: canvas.title || untitledCanvasLabel,
            icon: canvas.icon
          }
        }
        setCanvasNames(names)
      },
      (err: unknown) => {
        if (cancelled) return
        log.error('Linked canvas lookup failed:', extractErrorMessage(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [task?.id, linkedCanvasKey, task?.linkedCanvasIds, untitledCanvasLabel])

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
  }, [])

  const project = useMemo(
    () => (task ? (projects.find((p) => p.id === task.projectId) ?? null) : null),
    [task, projects]
  )

  const subtasks = useMemo(() => (task ? getSubtasks(task.id, tasks) : []), [task, tasks])

  const completedSubtaskCount = useMemo(
    () => subtasks.filter((s) => s.completedAt !== null).length,
    [subtasks]
  )

  const { notes: noteResults, canvases: canvasResults } = useRelatedItemSearch(
    isLinkingNote,
    noteSearchQuery,
    untitledCanvasLabel
  )

  const searchResults = useMemo<RelatedSearchItem[]>(() => {
    if (!task) return []
    const linkedNotes = new Set(task.linkedNoteIds)
    const linkedCanvases = new Set(task.linkedCanvasIds ?? [])
    return [
      ...noteResults.filter((note) => !linkedNotes.has(note.id)),
      ...canvasResults.filter((canvas) => !linkedCanvases.has(canvas.id))
    ]
  }, [task, noteResults, canvasResults])

  const handleStatusChange = useCallback(
    (statusId: string) => {
      if (task) onUpdateTask?.(task.id, { statusId })
    },
    [task, onUpdateTask]
  )

  const handlePriorityChange = useCallback(
    (priority: Priority) => {
      if (task) onUpdateTask?.(task.id, { priority })
    },
    [task, onUpdateTask]
  )

  const handleDueDateChange = useCallback(
    (dueDate: Date | null) => {
      if (task) onUpdateTask?.(task.id, { dueDate })
    },
    [task, onUpdateTask]
  )

  const handleDueTimeChange = useCallback(
    (dueTime: string | null) => {
      if (task) onUpdateTask?.(task.id, { dueTime })
    },
    [task, onUpdateTask]
  )

  const handleProjectChange = useCallback(
    (projectId: string) => {
      if (task) onUpdateTask?.(task.id, { projectId })
    },
    [task, onUpdateTask]
  )

  const handleTagsChange = useCallback(
    (tags: string[]) => {
      if (task) onUpdateTask?.(task.id, { tags })
    },
    [task, onUpdateTask]
  )

  // Description is a BlockNote markdown editor; debounce persistence so we don't
  // write to the DB (and bump the sync field clock) on every keystroke.
  const pendingDescriptionRef = useRef<string | null>(null)
  const descriptionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushDescription = useCallback(() => {
    if (descriptionTimerRef.current) {
      clearTimeout(descriptionTimerRef.current)
      descriptionTimerRef.current = null
    }
    if (pendingDescriptionRef.current !== null && task) {
      onUpdateTask?.(task.id, { description: pendingDescriptionRef.current })
      pendingDescriptionRef.current = null
    }
  }, [task, onUpdateTask])

  const handleDescriptionChange = useCallback(
    (markdown: string) => {
      pendingDescriptionRef.current = markdown
      if (descriptionTimerRef.current) clearTimeout(descriptionTimerRef.current)
      descriptionTimerRef.current = setTimeout(flushDescription, 500)
    },
    [flushDescription]
  )

  // Flush any pending description edit when the task changes or the drawer unmounts.
  useEffect(() => flushDescription, [flushDescription])

  const handleRepeatChange = useCallback(
    (repeatConfig: RepeatConfig | null) => {
      if (!task) return
      onUpdateTask?.(task.id, {
        repeatConfig,
        isRepeating: repeatConfig !== null
      })
    },
    [task, onUpdateTask]
  )

  // The drawer remounts per task (keyed in tasks.tsx), so entrance runs on
  // every open and task switch: a subtle materialize from the end edge.
  const entranceX = i18n.dir() === 'rtl' ? -16 : 16

  return (
    <motion.aside
      aria-label={t('task.details')}
      aria-hidden={!isOpen}
      inert={!isOpen || undefined}
      initial={
        isOpen ? (prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: entranceX }) : false
      }
      animate={{ opacity: isOpen ? 1 : 0, x: 0 }}
      transition={
        prefersReducedMotion ? { duration: 0.2 } : { type: 'spring', bounce: 0, duration: 0.3 }
      }
      className={cn(
        // ponytail: absolute (not fixed) so the drawer stays inside its own pane in split view
        // top-[38px] clears the toolbar chrome so the drawer header stays visible
        'absolute top-[38px] bottom-0 end-0 z-10 border-s bg-surface overflow-hidden',
        isOpen ? 'border-border' : 'border-transparent pointer-events-none'
      )}
      style={{
        width: isOpen ? `${width}px` : 0
      }}
    >
      <div
        style={{ width: `${width}px` }}
        className="h-full flex flex-col overflow-y-auto scrollbar-thin [font-synthesis:none] text-[12px] leading-4"
      >
        {task && project && (
          <>
            {/* ── Header: editable title + close ── */}
            <div className="flex items-center gap-2 shrink-0 py-3.5 px-5 border-b border-border">
              <input
                type="text"
                value={task.title}
                onChange={(e) => onUpdateTask?.(task.id, { title: e.target.value })}
                className="flex-1 min-w-0 text-[14px] font-medium text-text-primary bg-transparent outline-none truncate"
                placeholder={t('task.namePlaceholder')}
                aria-label={t('task.namePlaceholder')}
              />
              <button
                type="button"
                onClick={onClose}
                className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text-secondary hover:bg-surface-active/60 transition-all duration-150 ease-out active:scale-90 focus-visible:outline-none"
                aria-label={t('drawer.close')}
              >
                <X size={16} />
              </button>
            </div>

            {/* ── Properties Grid ── */}
            <div className="flex flex-col pt-3 pb-4 border-b border-border px-5">
              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  {t('task.status')}
                </span>
                <InteractiveStatusBadge
                  statusId={task.statusId}
                  statuses={project.statuses}
                  onStatusChange={handleStatusChange}
                />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  {t('task.priority')}
                </span>
                <InteractivePriorityBadge
                  priority={task.priority}
                  onPriorityChange={handlePriorityChange}
                  compact
                />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  {t('task.dueDate')}
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
                  {t('task.reminder')}
                </span>
                <TaskReminderButton taskId={task.id} />
              </div>

              <div className="flex items-center py-1.5">
                <span className="text-[12px] w-[90px] shrink-0 text-text-tertiary leading-4">
                  {t('task.project')}
                </span>
                <InteractiveProjectBadge
                  projectId={task.projectId}
                  projects={projects}
                  onProjectChange={handleProjectChange}
                  allowCreate
                />
              </div>
            </div>

            {/* ── Tags ── */}
            {/* TagAutocomplete brings its own label/padding/border chrome (see
                components/filing/tag-autocomplete.tsx), so it sits as its own
                section rather than nested in the compact properties-grid rows. */}
            <TagAutocomplete
              tags={task.tags}
              onTagsChange={handleTagsChange}
              placeholder={t('task.tags')}
            />

            {/* ── Description ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <SectionLabel>{t('task.description')}</SectionLabel>
              <TaskDescriptionEditor
                key={task.id}
                initialContent={task.description ?? ''}
                onContentChange={handleDescriptionChange}
                placeholder={t('task.descriptionPlaceholder')}
                ariaLabel={t('task.description')}
                className="text-[13px] leading-5 text-text-secondary"
              />
            </div>

            {/* ── Sub-issues ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <div className="flex items-center justify-between">
                <SectionLabel>{t('drawer.subIssues')}</SectionLabel>
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
                      aria-label={t('drawer.addSubIssue')}
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
                    className="flex items-center py-1 gap-2 text-start"
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
                    placeholder={t('drawer.subIssuePlaceholder')}
                    aria-label={t('drawer.subIssuePlaceholder')}
                    className="flex-1 text-[12px] leading-4 text-text-primary placeholder:text-text-tertiary bg-transparent outline-none"
                  />
                </div>
              )}
              {subtasks.length === 0 && !isAddingSubtask && (
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  {t('drawer.noSubIssues')}
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

            {/* ── Related ── */}
            <div className="flex flex-col py-4 px-5 gap-2 border-b border-border">
              <div className="flex items-center justify-between">
                <SectionLabel>{t('drawer.related')}</SectionLabel>
                <button
                  type="button"
                  onClick={handleStartLinkNote}
                  className="text-text-tertiary hover:text-text-secondary transition-colors"
                  aria-label={t('drawer.addRelatedItem')}
                >
                  <Plus size={14} />
                </button>
              </div>
              {relatedRefs.map((ref) => {
                const key = relatedItemKey(ref)
                const info = displayedRelatedNames[key]
                const openRef = (): void => {
                  if (ref.kind === 'canvas') onCanvasClick?.(ref.id, info?.title ?? null)
                  else onNoteClick?.(ref.id)
                }
                const unlinkRef = (): void => {
                  if (ref.kind === 'canvas') {
                    onUpdateTask?.(task.id, {
                      linkedCanvasIds: (task.linkedCanvasIds ?? []).filter((id) => id !== ref.id)
                    })
                    setCanvasNames((prev) => {
                      const next = { ...prev }
                      delete next[key]
                      return next
                    })
                  } else {
                    onUpdateTask?.(task.id, {
                      linkedNoteIds: task.linkedNoteIds.filter((id) => id !== ref.id)
                    })
                    setNoteNames((prev) => {
                      const next = { ...prev }
                      delete next[key]
                      return next
                    })
                  }
                }
                return (
                  <div
                    key={key}
                    className="group flex items-center rounded-md py-1.5 px-2.5 gap-2 bg-foreground/[0.03] hover:bg-foreground/[0.05] transition-colors cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={openRef}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        openRef()
                      }
                    }}
                  >
                    <RelatedIcon kind={ref.kind} info={info} projectColor={project.color} />
                    <span className="flex-1 min-w-0 text-[12px] text-text-secondary leading-4 truncate">
                      {info?.title ?? t('drawer.loading')}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        unlinkRef()
                      }}
                      className="shrink-0 rounded-sm p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-text-secondary transition-all"
                      aria-label={t('drawer.removeRelatedItem', {
                        title: info?.title ?? t('drawer.relatedItemFallback')
                      })}
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
                    placeholder={t('drawer.searchRelated')}
                    aria-label={t('drawer.searchRelated')}
                    className="text-[12px] leading-4 text-text-primary placeholder:text-text-tertiary bg-foreground/[0.03] rounded-md py-1.5 px-2.5 outline-none border border-border focus:border-ring"
                  />
                  <div className="max-h-[160px] overflow-y-auto scrollbar-thin flex flex-col gap-0.5">
                    {searchResults.map((item) => (
                      <button
                        key={relatedItemKey(item)}
                        type="button"
                        onClick={() => {
                          if (item.kind === 'canvas') {
                            onUpdateTask?.(task.id, {
                              linkedCanvasIds: [...(task.linkedCanvasIds ?? []), item.id]
                            })
                            setCanvasNames((prev) => ({
                              ...prev,
                              [relatedItemKey(item)]: {
                                kind: 'canvas',
                                title: item.title,
                                icon: item.icon
                              }
                            }))
                          } else {
                            onUpdateTask?.(task.id, {
                              linkedNoteIds: [...task.linkedNoteIds, item.id]
                            })
                            setNoteNames((prev) => ({
                              ...prev,
                              [relatedItemKey(item)]: {
                                kind: 'note',
                                title: item.title,
                                emoji: item.emoji,
                                fileType: item.fileType
                              }
                            }))
                          }
                          setNoteSearchQuery('')
                          setIsLinkingNote(false)
                        }}
                        className="flex items-center rounded-md py-1.5 px-2.5 gap-2 text-start hover:bg-foreground/[0.05] transition-colors"
                      >
                        <RelatedIcon kind={item.kind} info={item} projectColor={project.color} />
                        <span className="text-[12px] text-text-secondary leading-4 truncate">
                          {item.title}
                        </span>
                      </button>
                    ))}
                    {searchResults.length === 0 && (
                      <span className="text-[11px] text-text-tertiary leading-3.5 py-1.5 px-2.5">
                        {noteSearchQuery
                          ? t('drawer.noMatchingRelated')
                          : t('drawer.noRelatedAvailable')}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {relatedRefs.length === 0 && !isLinkingNote && (
                <span className="text-[11px] text-text-tertiary leading-3.5">
                  {t('drawer.noRelatedItems')}
                </span>
              )}
            </div>

            {/* ── Activity ── */}
            <TaskActivitySection
              taskId={task.id}
              taskTitle={task.title}
              language={i18n.language}
              label={<SectionLabel>{t('drawer.activity')}</SectionLabel>}
            />

            {/* ── Footer ── */}
            <div className="flex flex-col py-3 px-5 gap-3 mt-auto">
              {onDeleteTask && (
                <button
                  type="button"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  className="flex items-center gap-2 py-1.5 px-2.5 rounded-md text-[12px] leading-4 text-destructive hover:bg-destructive/10 transition-colors w-full"
                  aria-label={t('task.delete')}
                >
                  <Trash size={14} />
                  {t('task.delete')}
                </button>
              )}
              <span className="text-[11px] text-text-tertiary/60 leading-3.5">
                {t('task.created', { date: formatCreatedDate(task.createdAt, i18n.language) })}
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
      {isOpen && (
        <PanelResizeRail
          width={width}
          setWidth={setWidth}
          setIsResizing={setIsResizing}
          minPx={TASK_DETAIL_WIDTH_MIN_PX}
          maxPx={TASK_DETAIL_WIDTH_MAX_PX}
          defaultPx={TASK_DETAIL_WIDTH_DEFAULT_PX}
          ariaLabel={t('drawer.resize')}
        />
      )}
    </motion.aside>
  )
})
