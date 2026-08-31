import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useTaskBlockData } from './use-task-block-data'
import { serviceTaskToDisplayTask, PRIORITY_REVERSE } from './task-block-utils'
import { useTasksOptional } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { tasksService } from '@/services/tasks-service'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { Task as DisplayTask } from '@/data/task-model'
import { defaultStatuses, type Project, type Status } from '@/data/tasks-data'
import { TaskRow } from '@/components/tasks/task-row'
import { useT } from '@memry/i18n/renderer'

export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
  parentTaskId: string
}

export type TaskBlockInlineContent = string | { text?: string }

export interface TaskBlock {
  id: string
  type?: string
  props: TaskBlockProps & Record<string, unknown>
  children?: TaskBlock[]
  content?: TaskBlockInlineContent[]
}

export interface TaskBlockEditor {
  document: TaskBlock[]
  updateBlock: (
    block: TaskBlock,
    update: { type?: string; props?: Partial<TaskBlockProps> }
  ) => void
  replaceBlocks: (blocksToRemove: TaskBlock[], blocksToInsert: TaskBlock[]) => void
  removeBlocks: (blocks: TaskBlock[]) => void
  insertBlocks: (
    blocks: Array<{ type: 'paragraph' | 'taskBlock'; props?: Partial<TaskBlockProps> }>,
    referenceBlock: TaskBlock,
    placement: 'before' | 'after'
  ) => void
  setTextCursorPosition: (blockId: string, placement: 'start' | 'end') => void
  focus: () => void
  getTextCursorPosition: () => { block: TaskBlock }
}

interface TaskBlockRendererProps {
  block: TaskBlock
  editor: unknown
  contentRef: React.Ref<HTMLDivElement>
}

const BLOCKNOTE_OVERRIDES = `
  .bn-formatting-toolbar:empty { display: none !important; }
  .bn-block-content[data-content-type="taskBlock"] { cursor: default; }
  .bn-block[data-id]:has([data-content-type="taskBlock"]) { border: none !important; outline: none !important; box-shadow: none !important; }
  .bn-block[data-id]:has([data-content-type="taskBlock"]):focus-within { border: none !important; outline: none !important; box-shadow: none !important; }
  .bn-block-content[data-content-type="taskBlock"]:focus { outline: none !important; border: none !important; }
  [data-content-type="taskBlock"] * { outline: none !important; }
  /* Selection highlight: when ProseMirror puts a NodeSelection on the
     taskBlock (drag-handle click, Esc-then-arrow, etc.), our blanket
     outline:none rules above used to hide it. Restore a visible state so
     the user can confidently delete a selected block with Backspace. */
  .bn-block-content[data-content-type="taskBlock"].ProseMirror-selectednode,
  [data-content-type="taskBlock"]:has(.ProseMirror-selectednode),
  .bn-block[data-id]:has(> .bn-block-content[data-content-type="taskBlock"].ProseMirror-selectednode) {
    background-color: rgba(59, 130, 246, 0.12) !important;
    border-radius: 4px !important;
    box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5) !important;
  }
`

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({
  block,
  editor: editorInput,
  contentRef
}) => {
  const editor = editorInput as TaskBlockEditor
  const { t: tPhaseF } = useT('notes')
  const { taskId, title, checked, parentTaskId } = block.props
  const { task, isLoading: _isLoading, isDeleted } = useTaskBlockData(taskId)
  const tasksCtx = useTasksOptional()
  const { openTab } = useTabActions()
  const syncingRef = useRef(false)

  const isNewBlockRef = useRef(true)
  const wasDraftRef = useRef(!taskId)
  const [isEditingTitle, setIsEditingTitle] = useState(!taskId)
  const [editTitle, setEditTitle] = useState(title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipBlurRef = useRef(false)

  const projects = tasksCtx?.projects ?? []
  const defaultProject =
    projects.find((p: Project & { isInbox?: boolean }) => p.isDefault || p.isInbox) ?? projects[0]
  const project = projects.find((p) => p.id === task?.projectId) ?? defaultProject
  const statuses: Status[] = project?.statuses ?? defaultStatuses
  const isCompleted = task ? !!task.completedAt : checked

  const placeholderTask: import('@/data/task-model').Task = useMemo(
    () => ({
      id: '',
      title,
      description: '',
      projectId: project?.id ?? '',
      statusId: statuses[0]?.id ?? '',
      priority: 'none' as const,
      dueDate: null,
      dueTime: null,
      isRepeating: false,
      repeatConfig: null,
      linkedNoteIds: [],
      sourceNoteId: null,
      tags: [],
      parentId: null,
      subtaskIds: [],
      createdAt: new Date(),
      completedAt: null,
      archivedAt: null
    }),
    [project?.id, statuses, title]
  )

  const displayTask = useMemo(
    () => (task ? serviceTaskToDisplayTask(task, statuses[0]?.id ?? '') : null),
    [task, statuses]
  )

  // Auto-enter edit mode for newly created blocks. The cancellation flag +
  // cleanup return mark this as a synchronization effect (so the
  // unnecessary-effect lints recognize it as legitimate) and lets us drop the
  // pending editor.updateBlock call if the component unmounts mid-flight.
  useEffect(() => {
    let cancelled = false
    if (isNewBlockRef.current && taskId && !task) {
      setIsEditingTitle(true)
      if (!wasDraftRef.current) setEditTitle(title)
    }
    if (task) {
      isNewBlockRef.current = false
      if (wasDraftRef.current) {
        wasDraftRef.current = false
        if (editTitle.trim() && task.title !== editTitle.trim()) {
          void tasksService.update({ id: taskId, title: editTitle.trim() })
          queueMicrotask(() => {
            if (cancelled) return
            editor.updateBlock(block, {
              props: { ...block.props, title: editTitle.trim() }
            })
          })
        }
      }
    }
    return () => {
      cancelled = true
    }
  }, [taskId, task, title, editTitle, block, editor])

  // Focus title input when editing starts (double-rAF to beat ProseMirror focus restoration)
  useEffect(() => {
    if (!isEditingTitle) return
    let cancelled = false
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled && titleInputRef.current) {
          titleInputRef.current.focus()
          titleInputRef.current.setSelectionRange(
            titleInputRef.current.value.length,
            titleInputRef.current.value.length
          )
        }
      })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(rafId)
    }
  }, [isEditingTitle])

  // Sync block props with DB state (for markdown serialization). Cleanup +
  // microtask deferral keep the parent-callback work out of the synchronous
  // render path.
  useEffect(() => {
    if (!task || syncingRef.current) return
    const needsUpdate =
      task.title !== block.props.title || !!task.completedAt !== block.props.checked
    if (!needsUpdate) return () => {}
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      syncingRef.current = true
      editor.updateBlock(block, {
        props: { ...block.props, title: task.title, checked: !!task.completedAt }
      })
      if (!isEditingTitle) setEditTitle(task.title)
      syncingRef.current = false
    })
    return () => {
      cancelled = true
    }
  }, [task, block, editor, isEditingTitle])

  // Cleanup debounce timer
  useEffect(() => {
    return () => {
      if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
    }
  }, [])

  // --- Title editing handlers ---

  const saveTitleToDb = useCallback(
    async (newTitle: string) => {
      if (!newTitle.trim()) return
      syncingRef.current = true
      editor.updateBlock(block, { props: { ...block.props, title: newTitle.trim() } })
      if (taskId) {
        try {
          await tasksService.update({ id: taskId, title: newTitle.trim() })
        } finally {
          syncingRef.current = false
        }
      } else {
        syncingRef.current = false
      }
    },
    [taskId, block, editor]
  )

  const handleTitleChange = useCallback(
    (value: string) => {
      setEditTitle(value)
      if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
      titleSaveTimeoutRef.current = setTimeout(() => void saveTitleToDb(value), 600)
    },
    [saveTitleToDb]
  )

  const handleTitleBlur = useCallback(() => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
    if (editTitle.trim()) void saveTitleToDb(editTitle)
    setIsEditingTitle(false)
  }, [editTitle, saveTitleToDb])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
        if (editTitle.trim()) void saveTitleToDb(editTitle)
        setIsEditingTitle(false)
        return
      }

      // Tab inside the title input: indent (demote) this taskBlock under the
      // previous top-level taskBlock sibling. The BlockNote-native Tab
      // handler can't reach us here because focus lives in a regular HTML
      // input owned by this React component. Without this branch the browser
      // moves focus to the next focusable element, which is exactly the bug
      // the user reported as "Tab switches to another section".
      if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        if (parentTaskId) return // already nested; nothing to do
        const doc = editor.document
        const idx = doc.findIndex((b) => b.id === block.id)
        if (idx <= 0) return
        const prev = doc[idx - 1]
        if (prev?.type !== 'taskBlock' || !prev?.props?.taskId) return

        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
        const trimmedTitle = editTitle.trim()
        if (trimmedTitle && taskId && task && task.title !== trimmedTitle) {
          void tasksService.update({ id: taskId, title: trimmedTitle })
        }
        setIsEditingTitle(false)

        const movedChild = {
          ...block,
          props: {
            ...block.props,
            title: trimmedTitle || block.props.title,
            parentTaskId: prev.props.taskId
          }
        }
        const newParent = {
          ...prev,
          children: [...(prev.children ?? []), movedChild]
        }
        editor.replaceBlocks([prev, block], [newParent])

        if (taskId) {
          void tasksService.update({ id: taskId, parentId: prev.props.taskId })
        }
        return
      }

      // Shift+Tab inside the title input: lift this subtask back to a
      // top-level task. We need to physically move the block out of its
      // parent's children[] — clearing parentTaskId in props alone wouldn't
      // re-shape the document.
      if (e.key === 'Tab' && e.shiftKey) {
        e.preventDefault()
        if (!parentTaskId) return
        const doc = editor.document
        const parentBlock = doc.find(
          (b) => b.type === 'taskBlock' && b.children?.some((c) => c.id === block.id)
        )
        if (!parentBlock) return

        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
        const trimmedTitle = editTitle.trim()
        if (trimmedTitle && taskId && task && task.title !== trimmedTitle) {
          void tasksService.update({ id: taskId, title: trimmedTitle })
        }
        setIsEditingTitle(false)

        const remainingChildren = (parentBlock.children ?? []).filter((c) => c.id !== block.id)
        const newParent = { ...parentBlock, children: remainingChildren }
        const promotedSelf = {
          ...block,
          props: { ...block.props, title: trimmedTitle || block.props.title, parentTaskId: '' }
        }
        editor.replaceBlocks([parentBlock], [newParent, promotedSelf])

        if (taskId) {
          void tasksService.update({ id: taskId, parentId: null })
        }
        return
      }

      // Backspace inside an already-empty title input: tear down the whole
      // taskBlock. Without this branch the keypress just bubbles to the
      // browser, which has nothing to delete (input is already empty), and
      // the user has no way to remove an unwanted task block from the
      // keyboard. Mirrors the Enter empty-title teardown below: cancel the
      // pending debounced save, suppress the trailing blur side-effects,
      // delete the DB row, and remove the block.
      if (e.key === 'Backspace' && editTitle.length === 0) {
        e.preventDefault()
        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
        isNewBlockRef.current = false
        setIsEditingTitle(false)
        if (taskId) void tasksService.delete(taskId)

        const doc = editor.document
        const blockIdx = doc.findIndex((b) => b.id === block.id)
        const anchor = blockIdx > 0 ? doc[blockIdx - 1] : null

        editor.removeBlocks([block])

        requestAnimationFrame(() => {
          // Natural backspace feel: when the previous sibling is a regular
          // text block, drop the cursor at its end so the user can keep
          // typing where they left off. Task blocks are contentEditable
          // false and not a valid cursor target, so we fall back to
          // inserting a fresh paragraph (matching the Enter empty path) so
          // the cursor always has somewhere to land.
          if (anchor && anchor.type !== 'taskBlock') {
            editor.setTextCursorPosition(anchor.id, 'end')
            editor.focus()
            return
          }
          const updatedDoc = editor.document
          if (anchor) {
            editor.insertBlocks([{ type: 'paragraph' }], anchor, 'after')
          } else if (updatedDoc.length > 0) {
            editor.insertBlocks([{ type: 'paragraph' }], updatedDoc[0], 'before')
          }
          const finalDoc = editor.document
          const fallback = finalDoc[blockIdx] ?? finalDoc[finalDoc.length - 1]
          if (fallback) {
            editor.setTextCursorPosition(fallback.id, 'start')
            editor.focus()
          }
        })
        return
      }

      if (e.key === 'Enter') {
        e.preventDefault()
        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)

        const trimmed = editTitle.trim()
        if (trimmed) {
          isNewBlockRef.current = false
          void saveTitleToDb(trimmed)
          setIsEditingTitle(false)
          editor.insertBlocks(
            [{ type: 'taskBlock', props: { taskId: '', title: '', checked: false } }],
            block,
            'after'
          )
        } else {
          isNewBlockRef.current = false
          setIsEditingTitle(false)
          if (taskId) void tasksService.delete(taskId)
          const doc = editor.document
          const blockIdx = doc.findIndex((b) => b.id === block.id)
          const anchor = blockIdx > 0 ? doc[blockIdx - 1] : null
          editor.removeBlocks([block])
          const updatedDoc = editor.document
          if (anchor) {
            editor.insertBlocks([{ type: 'paragraph' }], anchor, 'after')
          } else if (updatedDoc.length > 0) {
            editor.insertBlocks([{ type: 'paragraph' }], updatedDoc[0], 'before')
          }
          requestAnimationFrame(() => {
            const finalDoc = editor.document
            const para = finalDoc[blockIdx] ?? finalDoc[finalDoc.length - 1]
            if (para) {
              editor.setTextCursorPosition(para.id, 'start')
              editor.focus()
            }
          })
        }
      }
    },
    [editor, block, taskId, task, parentTaskId, editTitle, saveTitleToDb]
  )

  // --- Task action handlers ---

  const handleToggleComplete = useCallback(
    async (taskIdArg: string) => {
      if (!taskIdArg) return
      const newChecked = !isCompleted
      editor.updateBlock(block, { props: { ...block.props, checked: newChecked } })
      // complete/uncomplete resolve a {success:false} envelope instead of
      // rejecting; a failure must revert the optimistic flip or the markdown
      // checkbox (source of truth) diverges from the tasks row.
      const result = newChecked
        ? await tasksService.complete({ id: taskIdArg })
        : await tasksService.uncomplete(taskIdArg)
      if (!result?.success) {
        editor.updateBlock(block, { props: { ...block.props, checked: !newChecked } })
        trackRendererError(
          'task_checkbox_toggle',
          new Error(result?.error ?? 'Task toggle returned success:false')
        )
      }
    },
    [isCompleted, block, editor]
  )

  const handleUpdateTask = useCallback(
    async (_taskId: string, updates: Partial<DisplayTask>) => {
      if (!taskId) return
      await tasksService.update({
        id: taskId,
        ...(updates.statusId !== undefined && { statusId: updates.statusId }),
        ...(updates.priority !== undefined && {
          priority: PRIORITY_REVERSE[updates.priority] ?? 0
        })
      })
    },
    [taskId]
  )

  const handleProjectChange = useCallback(
    async (projectId: string) => {
      if (!taskId) return
      await tasksService.update({ id: taskId, projectId })
    },
    [taskId]
  )

  const handleRemoveGhost = useCallback(() => {
    editor.removeBlocks([block])
  }, [block, editor])

  const navigateArrow = useMemo(
    () => (
      <button
        type="button"
        onClick={() => {
          openTab({
            type: 'tasks',
            title: 'Tasks',
            icon: 'list-checks',
            path: '/tasks',
            isPinned: false,
            isModified: false,
            isPreview: false,
            isDeleted: false,
            viewState: {
              openTaskId: taskId,
              selectedProjectId: task?.projectId ?? undefined,
              activeTab: 'all'
            }
          })
        }}
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 transition-opacity hover:bg-accent/80"
        title={tPhaseF(
          'phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.openInTaskPanel'
        )}
      >
        <ArrowUpRight className="size-3 text-muted-foreground" />
      </button>
    ),
    [tPhaseF, openTab, taskId, task?.projectId]
  )

  const titleInput = useCallback(
    () => (
      <input
        ref={titleInputRef}
        type="text"
        value={editTitle}
        onChange={(e) => handleTitleChange(e.target.value)}
        onBlur={handleTitleBlur}
        onKeyDown={handleTitleKeyDown}
        className="grow shrink min-w-0 bg-transparent text-[13px] font-medium outline-none text-foreground/90 placeholder:text-muted-foreground"
        placeholder={tPhaseF('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.taskName')}
        aria-label={tPhaseF('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.taskName')}
      />
    ),
    [editTitle, handleTitleBlur, handleTitleKeyDown, tPhaseF, handleTitleChange]
  )

  const clickableTitle = useCallback(() => {
    const resolvedTitle = displayTask?.title ?? title
    const isEmpty = !resolvedTitle.trim()
    return (
      <span
        role="button"
        tabIndex={0}
        aria-label={isEmpty ? 'Edit task name' : undefined}
        onClick={(e) => {
          e.stopPropagation()
          setIsEditingTitle(true)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            setIsEditingTitle(true)
          }
        }}
        className={cn(
          'grow shrink min-w-0 truncate cursor-text',
          'text-[13px] font-medium',
          isEmpty
            ? 'text-muted-foreground/70 italic'
            : isCompleted
              ? 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
              : 'text-foreground/90'
        )}
      >
        {isEmpty ? 'Task name…' : resolvedTitle}
      </span>
    )
  }, [displayTask?.title, title, isCompleted])

  // --- Render states ---

  if (isDeleted) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className={cn(
          'flex items-center gap-3 rounded-md bg-stone-100 py-[7px] text-sm text-muted-foreground opacity-60 dark:bg-stone-800/50',
          parentTaskId && 'ms-7'
        )}
      >
        <AlertTriangle className="size-4 text-amber-500" />
        <span className="line-through">{task?.title ?? title}</span>
        <span className="text-xs">
          {tPhaseF('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.taskDeleted')}
        </span>
        <button
          type="button"
          onClick={handleRemoveGhost}
          className="ms-auto rounded p-0.5 hover:bg-stone-200 dark:hover:bg-stone-700"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  // Render TaskRow — use real task if loaded, placeholder otherwise. The
  // placeholder carries an empty id, so every mutating handler behind it
  // early-returns: a checkbox with no `tasks` row (a half-converted Obsidian
  // line, or a `{task:<id>}` copied from another install) would otherwise show
  // a full set of controls that silently do nothing (#1907). Keep the row's
  // shape so notes don't flicker on open, but hand it no affordance it cannot
  // honour until the task resolves.
  const rowTask = displayTask ?? placeholderTask
  const hasResolvedTask = !!task
  const rowProject = project ?? defaultProject

  if (!rowProject) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className={cn(
          'flex items-center gap-3 rounded-md py-[7px] text-sm text-muted-foreground',
          parentTaskId && 'ms-7'
        )}
      >
        <Loader2 className="size-4 animate-spin" />

        {tPhaseF('phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.loading')}
      </div>
    )
  }

  return (
    <div
      ref={contentRef}
      contentEditable={false}
      className="w-full outline-none [&_*]:outline-none"
    >
      <style>{BLOCKNOTE_OVERRIDES}</style>
      <div className={cn(parentTaskId && 'ms-7')}>
        <TaskRow
          task={rowTask}
          project={rowProject}
          projects={projects}
          isCompleted={isCompleted}
          showProjectBadge
          interactive={hasResolvedTask}
          onToggleComplete={(...args) => void handleToggleComplete(...args)}
          onUpdateTask={(...args) => void handleUpdateTask(...args)}
          onProjectChange={(...args) => void handleProjectChange(...args)}
          actions={hasResolvedTask ? navigateArrow : null}
          renderTitle={isEditingTitle ? titleInput : clickableTitle}
          className="px-0"
        />
      </div>
    </div>
  )
}
