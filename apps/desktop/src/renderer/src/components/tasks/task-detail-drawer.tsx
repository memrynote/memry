import { useEffect, useRef, useState, useMemo, memo, useCallback } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { useT } from '@memry/i18n/renderer'
import { cn } from '@/lib/utils'
import { useResizablePanel } from '@/hooks/use-resizable-panel'
import { PanelResizeRail } from '@/components/ui/panel-resize-rail'
import { type Task, type Priority, type RepeatConfig } from '@/data/task-model'
import type { Project } from '@/data/tasks-data'
import { getSubtasks } from '@/lib/subtask-utils'
import {
  DatePropertyRow,
  PropertyRow,
  PROPERTY_ROW_TRIGGER,
  PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT,
  PROPERTY_ROW_TRIGGER_PROJECT
} from '@/components/tasks/date-property-row'
import { TaskRepeatRow } from '@/components/tasks/task-repeat-section'
import { TaskSubissuesSection } from '@/components/tasks/task-subissues-section'
import {
  DRAWER_ADD_ROW,
  DRAWER_ROW,
  DrawerSection,
  DrawerSectionHeading
} from '@/components/tasks/drawer-section'
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
import { ArrowUpRight, X, Plus, Trash } from '@/lib/icons'
import { TaskUnarchiveButton } from './task-unarchive-button'
import { DeleteTaskDialog } from '@/components/tasks/delete-task-dialog'
import { TaskActivitySection } from '@/components/tasks/task-activity-section'
import { RelatedIcon } from '@/components/tasks/related-item-icon'
import { relatedItemKey, useRelatedItemInfo } from '@/components/tasks/use-related-item-info'

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
  /** Shown where the drawer opens over another surface, to reach the task in Tasks. */
  onOpenInTasks?: () => void
  className?: string
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
  onDeleteTask,
  onOpenInTasks,
  className
}: TaskDetailDrawerProps): React.JSX.Element | null {
  const { t, i18n } = useT('tasks')
  const { t: tCommon } = useT('common')
  const prefersReducedMotion = useReducedMotion()
  const { width, setWidth, setIsResizing } = useResizablePanel({
    storageKey: TASK_DETAIL_WIDTH_KEY,
    defaultPx: TASK_DETAIL_WIDTH_DEFAULT_PX,
    minPx: TASK_DETAIL_WIDTH_MIN_PX,
    maxPx: TASK_DETAIL_WIDTH_MAX_PX
  })
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false)

  const untitledCanvasLabel = tCommon('canvas.untitled')
  const {
    refs: relatedRefs,
    infoByKey: displayedRelatedNames,
    remember: rememberRelatedItem,
    forget: forgetRelatedItem
  } = useRelatedItemInfo(task?.linkedNoteIds, task?.linkedCanvasIds, untitledCanvasLabel)

  const [isLinkingNote, setIsLinkingNote] = useState(false)
  const [noteSearchQuery, setNoteSearchQuery] = useState('')
  const noteSearchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isOpen) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (isLinkingNote) {
          setIsLinkingNote(false)
          setNoteSearchQuery('')
        } else {
          onClose()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [isOpen, onClose, isLinkingNote])

  const handleStartLinkNote = useCallback(() => {
    setIsLinkingNote(true)
    requestAnimationFrame(() => noteSearchInputRef.current?.focus())
  }, [])

  const project = useMemo(
    () => (task ? (projects.find((p) => p.id === task.projectId) ?? null) : null),
    [task, projects]
  )

  const subtasks = useMemo(() => (task ? getSubtasks(task.id, tasks) : []), [task, tasks])

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

  const handleStartDateChange = useCallback(
    (startDate: Date | null) => {
      if (task) onUpdateTask?.(task.id, { startDate })
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

  // Closed, the drawer leaves the DOM. It used to stay mounted behind `inert`,
  // `aria-hidden` and `width: 0`, but a 1px border still gave it a box, so
  // Playwright reported it visible in both states and every `state: 'visible'`
  // or `state: 'hidden'` wait on it passed without proving anything. Nothing is
  // lost by unmounting: `task` is null while closed, the `key` in tasks.tsx
  // already forced a remount on every open, and the width lives in
  // localStorage. `data-state="open"` is the selector specs address it by, so
  // the open drawer is named positively and closed means "no such element".
  if (!isOpen) return null

  return (
    <motion.aside
      aria-label={t('task.details')}
      data-state="open"
      initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: entranceX }}
      animate={{ opacity: 1, x: 0 }}
      transition={
        prefersReducedMotion ? { duration: 0.2 } : { type: 'spring', bounce: 0, duration: 0.3 }
      }
      // ponytail: absolute (not fixed) so the drawer stays inside its own pane in split view
      // top-[38px] clears the toolbar chrome so the drawer header stays visible
      className={cn(
        'absolute top-[38px] bottom-0 end-0 z-10 border-s border-border bg-surface overflow-hidden',
        className
      )}
      style={{ width: `${width}px` }}
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
                onChange={(e) => {
                  // Every keystroke is a `tasks:update`, so select-all + delete
                  // used to send `title: ''` at a `min(1)` contract. A task
                  // cannot be untitled; drop the empty edit instead (#1991).
                  if (!e.target.value.trim()) return
                  onUpdateTask?.(task.id, { title: e.target.value })
                }}
                className="flex-1 min-w-0 text-[14px] font-medium text-text-primary bg-transparent outline-none truncate"
                placeholder={t('task.namePlaceholder')}
                aria-label={t('task.namePlaceholder')}
              />
              {onOpenInTasks && (
                <button
                  type="button"
                  onClick={onOpenInTasks}
                  className="shrink-0 rounded-sm p-0.5 text-text-tertiary hover:text-text-secondary hover:bg-surface-active/60 transition-[color,background-color,scale] duration-150 ease-out active:scale-90 focus-visible:outline-none"
                  aria-label={t('drawer.openInTasks')}
                  title={t('drawer.openInTasks')}
                >
                  <ArrowUpRight size={16} />
                </button>
              )}
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
            {/* px-3 + the trigger's px-2 = 20px icon lane, in line with the title. */}
            <div className="flex flex-col gap-0.5 py-2.5 border-b border-border px-3">
              <PropertyRow label={t('task.status')}>
                <InteractiveStatusBadge
                  statusId={task.statusId}
                  statuses={project.statuses}
                  onStatusChange={handleStatusChange}
                  className={PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT}
                />
              </PropertyRow>

              <PropertyRow label={t('task.priority')}>
                <InteractivePriorityBadge
                  priority={task.priority}
                  onPriorityChange={handlePriorityChange}
                  className={PROPERTY_ROW_TRIGGER_NEUTRAL_TEXT}
                />
              </PropertyRow>

              <DatePropertyRow
                label={t('task.startDate')}
                date={task.startDate ?? null}
                kind="start"
                isCompleted={!!task.completedAt}
              >
                <InteractiveDueDateBadge
                  dateKind="start"
                  dueDate={task.startDate ?? null}
                  dueTime={null}
                  onDateChange={handleStartDateChange}
                  variant="property"
                  className={PROPERTY_ROW_TRIGGER}
                />
              </DatePropertyRow>

              <DatePropertyRow
                label={t('task.dueDate')}
                date={task.dueDate}
                kind="due"
                isCompleted={!!task.completedAt}
              >
                <InteractiveDueDateBadge
                  dueDate={task.dueDate}
                  dueTime={task.dueTime}
                  onDateChange={handleDueDateChange}
                  onTimeChange={handleDueTimeChange}
                  isRepeating={task.isRepeating}
                  variant="property"
                  className={PROPERTY_ROW_TRIGGER}
                />
              </DatePropertyRow>

              <TaskRepeatRow
                taskTitle={task.title}
                repeatConfig={task.repeatConfig}
                isRepeating={task.isRepeating}
                dueDate={task.dueDate}
                onRepeatChange={handleRepeatChange}
              />

              <PropertyRow label={t('task.reminder')}>
                <TaskReminderButton taskId={task.id} className={PROPERTY_ROW_TRIGGER} />
              </PropertyRow>

              <PropertyRow label={t('task.project')}>
                <InteractiveProjectBadge
                  projectId={task.projectId}
                  projects={projects}
                  onProjectChange={handleProjectChange}
                  allowCreate
                  className={PROPERTY_ROW_TRIGGER_PROJECT}
                />
              </PropertyRow>

              <TagAutocomplete tags={task.tags} onTagsChange={handleTagsChange} variant="row" />
            </div>

            {/* ── Description: no heading, the text speaks for itself ── */}
            <div className="px-5 pt-4 pb-1">
              <TaskDescriptionEditor
                key={task.id}
                initialContent={task.description ?? ''}
                onContentChange={handleDescriptionChange}
                placeholder={t('task.descriptionPlaceholder')}
                ariaLabel={t('task.description')}
                className="text-[13px] leading-5 text-text-primary"
              />
            </div>

            <TaskSubissuesSection
              subtasks={subtasks}
              statuses={project.statuses}
              onToggleComplete={onToggleComplete}
              onAddSubtask={onAddSubtask && ((title) => onAddSubtask(task.id, title))}
            />

            {/* ── Related ── */}
            <DrawerSection>
              <DrawerSectionHeading count={relatedRefs.length || undefined}>
                {t('drawer.related')}
              </DrawerSectionHeading>
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
                    forgetRelatedItem(ref)
                  } else {
                    onUpdateTask?.(task.id, {
                      linkedNoteIds: task.linkedNoteIds.filter((id) => id !== ref.id)
                    })
                    forgetRelatedItem(ref)
                  }
                }
                return (
                  <div
                    key={key}
                    className={cn(DRAWER_ROW, 'group cursor-pointer')}
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
                    <span className="flex-1 min-w-0 text-text-primary truncate">
                      {info?.title ?? t('drawer.loading')}
                    </span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        unlinkRef()
                      }}
                      className="shrink-0 rounded-sm p-0.5 text-text-tertiary opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-text-secondary transition-all"
                      aria-label={t('drawer.removeRelatedItem', {
                        title: info?.title ?? t('drawer.relatedItemFallback')
                      })}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )
              })}
              {isLinkingNote ? (
                <div className="flex flex-col gap-0.5">
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
                    className="h-7 rounded-md px-2 text-[13px] leading-[18px] text-text-primary placeholder:text-text-tertiary bg-surface-active/60 outline-none"
                  />
                  <div className="max-h-[168px] overflow-y-auto scrollbar-thin flex flex-col">
                    {searchResults.map((item) => (
                      <button
                        key={relatedItemKey(item)}
                        type="button"
                        onClick={() => {
                          if (item.kind === 'canvas') {
                            onUpdateTask?.(task.id, {
                              linkedCanvasIds: [...(task.linkedCanvasIds ?? []), item.id]
                            })
                            rememberRelatedItem(item, {
                              kind: 'canvas',
                              title: item.title,
                              icon: item.icon
                            })
                          } else {
                            onUpdateTask?.(task.id, {
                              linkedNoteIds: [...task.linkedNoteIds, item.id]
                            })
                            rememberRelatedItem(item, {
                              kind: 'note',
                              title: item.title,
                              emoji: item.emoji,
                              fileType: item.fileType
                            })
                          }
                          setNoteSearchQuery('')
                          setIsLinkingNote(false)
                        }}
                        className={DRAWER_ROW}
                      >
                        <RelatedIcon kind={item.kind} info={item} projectColor={project.color} />
                        <span className="text-text-primary truncate">{item.title}</span>
                      </button>
                    ))}
                    {searchResults.length === 0 && (
                      <span className="px-2 text-[12px] leading-7 text-text-tertiary">
                        {noteSearchQuery
                          ? t('drawer.noMatchingRelated')
                          : t('drawer.noRelatedAvailable')}
                      </span>
                    )}
                  </div>
                </div>
              ) : (
                <button type="button" onClick={handleStartLinkNote} className={DRAWER_ADD_ROW}>
                  <Plus className="size-3.5 shrink-0" aria-hidden="true" />
                  {t('drawer.addRelatedItem')}
                </button>
              )}
            </DrawerSection>

            {/* ── Activity ── */}
            <TaskActivitySection
              taskId={task.id}
              taskTitle={task.title}
              language={i18n.language}
              label={t('drawer.activity')}
            />

            {/* ── Footer ── */}
            <div className="flex flex-col py-3 px-5 gap-3 mt-auto">
              {task.archivedAt !== null && onUpdateTask && (
                <TaskUnarchiveButton
                  onUnarchive={() => onUpdateTask(task.id, { archivedAt: null })}
                />
              )}
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
      <PanelResizeRail
        width={width}
        setWidth={setWidth}
        setIsResizing={setIsResizing}
        minPx={TASK_DETAIL_WIDTH_MIN_PX}
        maxPx={TASK_DETAIL_WIDTH_MAX_PX}
        defaultPx={TASK_DETAIL_WIDTH_DEFAULT_PX}
        ariaLabel={t('drawer.resize')}
      />
    </motion.aside>
  )
})
