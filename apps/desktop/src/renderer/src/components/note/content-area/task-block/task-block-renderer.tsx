import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Loader2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTaskBlockData } from './use-task-block-data'
import { serviceTaskToDisplayTask, PRIORITY_REVERSE } from './task-block-utils'
import { useTasksOptional } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { tasksService } from '@/services/tasks-service'
import type { Task as DisplayTask } from '@/data/sample-tasks'
import { defaultStatuses, type Status } from '@/data/tasks-data'
import { TaskRow } from '@/components/tasks/task-row'

interface TaskBlockRendererProps {
  block: {
    id: string
    props: { taskId: string; title: string; checked: boolean; parentTaskId: string }
  }
  editor: any
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

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({ block, editor, contentRef }) => {
  const { taskId, title, checked, parentTaskId } = block.props
  const { task, isLoading, isDeleted } = useTaskBlockData(taskId)
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
  const defaultProject = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
  const project = projects.find((p) => p.id === task?.projectId) ?? defaultProject
  const statuses: Status[] = (project?.statuses as Status[]) ?? defaultStatuses
  const isCompleted = task ? !!task.completedAt : checked

  const placeholderTask: import('@/data/sample-tasks').Task = useMemo(
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

  // Auto-enter edit mode for newly created blocks
  useEffect(() => {
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
          editor.updateBlock(block, {
            props: { ...block.props, title: editTitle.trim() }
          })
        }
      }
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

  // Sync block props with DB state (for markdown serialization)
  useEffect(() => {
    if (!task || syncingRef.current) return
    const needsUpdate =
      task.title !== block.props.title || !!task.completedAt !== block.props.checked
    if (needsUpdate) {
      syncingRef.current = true
      editor.updateBlock(block, {
        props: { ...block.props, title: task.title, checked: !!task.completedAt }
      })
      if (!isEditingTitle) setEditTitle(task.title)
      syncingRef.current = false
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
        const doc = editor.document as any[]
        const idx = doc.findIndex((b: any) => b.id === block.id)
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
          children: [...((prev.children as any[]) ?? []), movedChild]
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
        const doc = editor.document as any[]
        const parentBlock = doc.find(
          (b: any) =>
            b.type === 'taskBlock' &&
            (b.children as any[] | undefined)?.some((c: any) => c.id === block.id)
        )
        if (!parentBlock) return

        skipBlurRef.current = true
        if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
        const trimmedTitle = editTitle.trim()
        if (trimmedTitle && taskId && task && task.title !== trimmedTitle) {
          void tasksService.update({ id: taskId, title: trimmedTitle })
        }
        setIsEditingTitle(false)

        const remainingChildren = ((parentBlock.children as any[]) ?? []).filter(
          (c: any) => c.id !== block.id
        )
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

        const doc = editor.document as any[]
        const blockIdx = doc.findIndex((b: any) => b.id === block.id)
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
          const updatedDoc = editor.document as any[]
          if (anchor) {
            editor.insertBlocks([{ type: 'paragraph' as any }], anchor, 'after')
          } else if (updatedDoc.length > 0) {
            editor.insertBlocks([{ type: 'paragraph' as any }], updatedDoc[0], 'before')
          }
          const finalDoc = editor.document as any[]
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
            [{ type: 'taskBlock' as any, props: { taskId: '', title: '', checked: false } }],
            block,
            'after'
          )
        } else {
          isNewBlockRef.current = false
          setIsEditingTitle(false)
          if (taskId) void tasksService.delete(taskId)
          const doc = editor.document as any[]
          const blockIdx = doc.findIndex((b: any) => b.id === block.id)
          const anchor = blockIdx > 0 ? doc[blockIdx - 1] : null
          editor.removeBlocks([block])
          const updatedDoc = editor.document as any[]
          if (anchor) {
            editor.insertBlocks([{ type: 'paragraph' as any }], anchor, 'after')
          } else if (updatedDoc.length > 0) {
            editor.insertBlocks([{ type: 'paragraph' as any }], updatedDoc[0], 'before')
          }
          requestAnimationFrame(() => {
            const finalDoc = editor.document as any[]
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
      if (newChecked) {
        await tasksService.complete({ id: taskIdArg })
      } else {
        await tasksService.uncomplete(taskIdArg)
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
        title="Open in task panel"
      >
        <ArrowUpRight className="size-3 text-muted-foreground" />
      </button>
    ),
    [openTab, taskId, task?.projectId]
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
        placeholder="Task name..."
      />
    ),
    [editTitle, handleTitleChange, handleTitleBlur, handleTitleKeyDown]
  )

  const clickableTitle = useCallback(
    () => (
      <span
        role="button"
        tabIndex={0}
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
          isCompleted
            ? 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
            : 'text-foreground/90'
        )}
      >
        {displayTask?.title ?? title}
      </span>
    ),
    [displayTask?.title, title, isCompleted]
  )

  // --- Render states ---

  if (isDeleted) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className={cn(
          'flex items-center gap-3 rounded-md bg-stone-100 py-[7px] text-sm text-muted-foreground opacity-60 dark:bg-stone-800/50',
          parentTaskId && 'ml-7'
        )}
      >
        <AlertTriangle className="size-4 text-amber-500" />
        <span className="line-through">{task?.title ?? title}</span>
        <span className="text-xs">Task deleted</span>
        <button
          type="button"
          onClick={handleRemoveGhost}
          className="ml-auto rounded p-0.5 hover:bg-stone-200 dark:hover:bg-stone-700"
        >
          <X className="size-3" />
        </button>
      </div>
    )
  }

  // Render TaskRow — use real task if loaded, placeholder otherwise
  const rowTask = displayTask ?? placeholderTask
  const rowProject = project ?? defaultProject

  if (!rowProject) {
    return (
      <div
        ref={contentRef}
        contentEditable={false}
        className={cn(
          'flex items-center gap-3 rounded-md py-[7px] text-sm text-muted-foreground',
          parentTaskId && 'ml-7'
        )}
      >
        <Loader2 className="size-4 animate-spin" />
        Loading...
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
      <div className={cn(parentTaskId && 'ml-7')}>
        <TaskRow
          task={rowTask}
          project={rowProject}
          projects={projects}
          isCompleted={isCompleted}
          showProjectBadge
          onToggleComplete={handleToggleComplete}
          onUpdateTask={handleUpdateTask}
          onProjectChange={handleProjectChange}
          actions={navigateArrow}
          renderTitle={isEditingTitle ? titleInput : clickableTitle}
          className="px-0"
        />
      </div>
    </div>
  )
}
