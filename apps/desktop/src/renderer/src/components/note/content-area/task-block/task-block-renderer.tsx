import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, ArrowUpRight, Loader2, X } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { useTaskBlockData } from './use-task-block-data'
import { useTaskPrefetch } from './task-prefetch-context'
import { serviceTaskToDisplayTask } from './task-block-utils'
import { hasPendingQuickAddSyntax, parseQuickAddEdit } from './quick-add-edit'
import { TaskBlockProperties, missingTaskProperties } from './properties/task-block-properties'
import { AddPropertyMenu } from './properties/add-property-menu'
import { QuickAddPreview } from './properties/quick-add-preview'
import { resolvePropertyShortcut, type TaskPropertyId } from './properties/task-property-ids'
import { useTasksOptional } from '@/contexts/tasks'
import { useTabActions } from '@/contexts/tabs'
import { useOpenTaskDetail } from '@/components/tasks/task-detail-host'
import { tasksService } from '@/services/tasks-service'
import { markTaskRemovalsHandled } from '../task-removal'
import { toTaskUpdateInput } from '@/features/tasks/task-update-input'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import { openRelatedVaultItem } from '@/lib/open-related-vault-item'
import { canvasTabData } from '@/lib/sidebar-tab-data'
import type { Task as DisplayTask } from '@/data/task-model'
import { defaultStatuses, type Project, type Status } from '@/data/tasks-data'
import { TaskRow } from '@/components/tasks/task-row'
import type { RelatedRef } from '@/components/tasks/use-related-item-info'
import { useT } from '@memry/i18n/renderer'

export interface TaskBlockProps {
  taskId: string
  title: string
  checked: boolean
  parentTaskId: string
}

/** Row edits made before the block had a task id, replayed once it has one. */
interface PendingTaskUpdates {
  changes: Partial<DisplayTask>
  completed?: boolean
}

/** Anything in the row that takes its own clicks and keys. */
const INTERACTIVE_SELECTOR = 'button, input, textarea, a, [role="button"]'

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

/**
 * No `contentRef`: BlockNote 0.54 stopped handing one to a block declared
 * `content: "none"`, which this one is. There was never a content DOM to
 * attach it to — the ref only ever landed on our own wrapper.
 */
interface TaskBlockRendererProps {
  block: TaskBlock
  editor: unknown
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

/**
 * Which project and status set a block renders against: the task's own project,
 * then the project a draft in this note would be created in, and the first
 * project the context knows as a last resort. Resolved outside the component so
 * this fallback chain is not part of its control flow.
 */
const resolveBlockProject = (
  contextProjects: Project[] | undefined,
  taskProjectId: string | undefined,
  draftProjectId: string | null
): { projects: Project[]; project: Project | undefined; statuses: Status[] } => {
  const projects = contextProjects ?? []
  const fallback =
    projects.find((p) => p.id === draftProjectId) ??
    projects.find((p: Project & { isInbox?: boolean }) => p.isDefault || p.isInbox) ??
    projects[0]
  const project = projects.find((p) => p.id === taskProjectId) ?? fallback

  return { projects, project, statuses: project?.statuses ?? defaultStatuses }
}

/**
 * The row still has to render before a task exists behind the block — a line
 * the user is typing, or one whose task has not loaded yet. Kept out of the
 * component so its own fallbacks stay out of the renderer body.
 */
const makePlaceholderTask = (
  title: string,
  project: Project | undefined,
  statuses: Status[]
): DisplayTask => ({
  id: '',
  title,
  description: '',
  projectId: project?.id ?? '',
  statusId: statuses[0]?.id ?? '',
  priority: 'none',
  dueDate: null,
  dueTime: null,
  isRepeating: false,
  repeatConfig: null,
  repeatFrom: null,
  linkedNoteIds: [],
  sourceNoteId: null,
  tags: [],
  parentId: null,
  subtaskIds: [],
  createdAt: new Date(),
  completedAt: null,
  archivedAt: null
})

export const TaskBlockRenderer: FC<TaskBlockRendererProps> = ({ block, editor: editorInput }) => {
  const editor = editorInput as TaskBlockEditor
  const { t: tPhaseF } = useT('notes')
  const { t: tCommon } = useT('common')
  const { taskId, title, checked, parentTaskId } = block.props
  const { task, isLoading: _isLoading, isDeleted } = useTaskBlockData(taskId)
  const { draftProjectId, noteId: hostNoteId, hasActiveReminder } = useTaskPrefetch()
  const tasksCtx = useTasksOptional()
  const { openTab } = useTabActions()
  const openTaskDetail = useOpenTaskDetail()
  const syncingRef = useRef(false)

  const isNewBlockRef = useRef(true)
  const wasDraftRef = useRef(!taskId)
  const [isEditingTitle, setIsEditingTitle] = useState(!taskId)
  const [editTitle, setEditTitle] = useState(title)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const titleSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const skipBlurRef = useRef(false)

  // What the user changed on a block whose task row does not exist yet. The
  // block is a `taskBlock` from the moment the checkbox is rewritten, but its
  // `taskId` only arrives when `tasks:create` resolves; every handler below
  // used to drop the change on the floor in that window (#2271). Held here and
  // applied the moment the id lands, so a project picked one keystroke too
  // early is still the project the task is created into.
  const pendingUpdatesRef = useRef<PendingTaskUpdates>({ changes: {} })

  // Which picker is open, the one piece of state for every property control
  // in the row. Opening one closes the last, so one popover is ever on screen.
  const [openProperty, setOpenProperty] = useState<TaskPropertyId | null>(null)
  const handlePropertyOpenChange = useCallback((id: TaskPropertyId, open: boolean) => {
    setOpenProperty((prev) => (open ? id : prev === id ? null : prev))
  }, [])

  // The block itself takes focus (Esc from the title, a click on the row's
  // empty space), and while it has it the property keys work: D for due, L for
  // tags and so on.
  const rowRef = useRef<HTMLDivElement>(null)
  const focusRowSoon = useCallback(() => {
    // Double rAF, same as the title input: ProseMirror restores its own focus
    // on the frame after a click inside the editor.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => rowRef.current?.focus())
    })
  }, [])

  const { projects, project, statuses } = resolveBlockProject(
    tasksCtx?.projects,
    task?.projectId,
    draftProjectId
  )
  const isCompleted = task ? !!task.completedAt : checked

  const placeholderTask = useMemo(
    () => makePlaceholderTask(title, project, statuses),
    [project, statuses, title]
  )

  const displayTask = useMemo(
    () => (task ? serviceTaskToDisplayTask(task, statuses[0]?.id ?? '') : null),
    [task, statuses]
  )

  // Shorthand typed into the title, parsed against what the task already says
  // so only new tokens count. Drives the dashed preview while typing; the same
  // parse is applied when the edit is committed.
  const quickAddEdit = useMemo(
    () =>
      isEditingTitle
        ? parseQuickAddEdit(editTitle, task?.title ?? '', displayTask, projects)
        : null,
    [isEditingTitle, editTitle, task?.title, displayTask, projects]
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
        // Shorthand still being typed is the commit's to apply; writing it now
        // would put the raw tokens in the title.
        if (
          editTitle.trim() &&
          task.title !== editTitle.trim() &&
          !hasPendingQuickAddSyntax(editTitle, task.title)
        ) {
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
      task.title !== block.props.title || Boolean(task.completedAt) !== block.props.checked
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

  // --- Property writes ---

  // Every property edit from the row goes through here. Without a task id yet
  // the edit is held and replayed when the id lands (see the replay effect).
  const applyUpdates = useCallback(
    async (updates: Partial<DisplayTask>): Promise<void> => {
      if (Object.keys(updates).length === 0) return
      if (!taskId) {
        Object.assign(pendingUpdatesRef.current.changes, updates)
        return
      }
      const result = await tasksService.update(toTaskUpdateInput(taskId, updates))
      if (result && !result.success) {
        trackRendererError(
          'task_block_update',
          new Error(result.error ?? 'Task update returned success:false')
        )
      }
    },
    [taskId]
  )

  const handleUpdate = useCallback(
    (updates: Partial<DisplayTask>) => void applyUpdates(updates),
    [applyUpdates]
  )
  const handleDescriptionChange = useCallback(
    (description: string) => void applyUpdates({ description }),
    [applyUpdates]
  )
  const handleTagsChange = useCallback(
    (tags: string[]) => void applyUpdates({ tags }),
    [applyUpdates]
  )

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

  /**
   * The title a committed edit leaves, with any shorthand in it applied: `Buy
   * milk #groceries @fri` saves as "Buy milk" and sets the tag and the date
   * (#2241). Returns the title to write, or '' when there is nothing to name
   * the task with.
   */
  const commitTitleEdit = useCallback(
    (raw: string): string => {
      const edit = parseQuickAddEdit(raw, task?.title ?? '', displayTask, projects)
      if (edit) void applyUpdates(edit.changes)
      return edit ? edit.title : raw.trim()
    },
    [task?.title, displayTask, projects, applyUpdates]
  )

  const handleTitleChange = useCallback(
    (value: string) => {
      setEditTitle(value)
      if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
      // Shorthand in progress is held back until the commit parses it; saving
      // it here would write `!hi` into the title, and for a draft hand the raw
      // tokens to the create.
      if (hasPendingQuickAddSyntax(value, task?.title ?? '')) return
      titleSaveTimeoutRef.current = setTimeout(() => void saveTitleToDb(value), 600)
    },
    [saveTitleToDb, task?.title]
  )

  const handleTitleBlur = useCallback(() => {
    if (skipBlurRef.current) {
      skipBlurRef.current = false
      return
    }
    if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
    if (editTitle.trim()) {
      const committed = commitTitleEdit(editTitle)
      if (committed) {
        setEditTitle(committed)
        void saveTitleToDb(committed)
      }
    }
    setIsEditingTitle(false)
    // Esc reaches the title as this blur, not as a key: the app's capture-phase
    // Escape handler (use-hint-activation) blurs inputs before React sees the
    // key, and the input is gone by then. Focus that went nowhere, as it does
    // after Esc, leaves the task selected so its property keys keep working.
    // Focus that went somewhere (the editor, another pane, another app) stays.
    if (taskId) {
      requestAnimationFrame(() => {
        if (document.hasFocus() && document.activeElement === document.body) {
          rowRef.current?.focus()
        }
      })
    }
  }, [editTitle, saveTitleToDb, commitTitleEdit, taskId])

  const handleTitleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        // The app's capture-phase Escape handler (use-hint-activation) blurs a
        // focused input before this runs, and that blur already committed the
        // edit. Committing again would write it twice, and arming the blur
        // skip here would swallow the next session's blur instead.
        if (document.activeElement === e.currentTarget) {
          skipBlurRef.current = true
          if (titleSaveTimeoutRef.current) clearTimeout(titleSaveTimeoutRef.current)
          if (editTitle.trim()) {
            const committed = commitTitleEdit(editTitle)
            if (committed) {
              setEditTitle(committed)
              void saveTitleToDb(committed)
            }
          }
        }
        setIsEditingTitle(false)
        // Esc leaves the task selected, like Linear: the property keys work
        // from here without reaching for the mouse.
        if (taskId) focusRowSoon()
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
        const trimmedTitle = commitTitleEdit(editTitle)
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
        const trimmedTitle = commitTitleEdit(editTitle)
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
        // Emptying the title and pressing Backspace is deleting the task, not
        // just its line, so the editor's removal prompt stays out of it.
        if (taskId) {
          markTaskRemovalsHandled(editor, [taskId])
          void tasksService.delete(taskId)
        }

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
          const committed = commitTitleEdit(editTitle) || trimmed
          setEditTitle(committed)
          void saveTitleToDb(committed)
          setIsEditingTitle(false)
          editor.insertBlocks(
            [{ type: 'taskBlock', props: { taskId: '', title: '', checked: false } }],
            block,
            'after'
          )
        } else {
          isNewBlockRef.current = false
          setIsEditingTitle(false)
          if (taskId) {
            markTaskRemovalsHandled(editor, [taskId])
            void tasksService.delete(taskId)
          }
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
    [
      editor,
      block,
      taskId,
      task,
      parentTaskId,
      editTitle,
      saveTitleToDb,
      commitTitleEdit,
      focusRowSoon
    ]
  )

  // --- Task action handlers ---

  const handleToggleComplete = useCallback(
    async (taskIdArg: string) => {
      const newChecked = !isCompleted
      // No row behind the block yet. A draft (`taskId: ''`) is one the
      // create is still catching up with, so the tick lands on the markdown
      // checkbox now and on the task once it exists. An unresolved
      // `{task:<id>}` has nothing to tick and never gets one (#1907).
      if (!taskIdArg) {
        if (taskId) return
        editor.updateBlock(block, { props: { ...block.props, checked: newChecked } })
        pendingUpdatesRef.current.completed = newChecked
        return
      }
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
    [isCompleted, block, editor, taskId]
  )

  const handleUpdateTask = useCallback(
    (_taskId: string, updates: Partial<DisplayTask>) => applyUpdates(updates),
    [applyUpdates]
  )

  const handleProjectChange = useCallback(
    (projectId: string) => applyUpdates({ projectId }),
    [applyUpdates]
  )

  // Replay of the above. Runs on the id, not on the loaded task: the row
  // exists as soon as `tasks:create` has handed the block an id, and waiting
  // for the fetch would race the title write that follows it.
  useEffect(() => {
    if (!taskId) return
    const {
      completed,
      changes: { projectId, ...updates }
    } = pendingUpdatesRef.current
    pendingUpdatesRef.current = { changes: {} }
    void (async () => {
      // The project move goes first and alone. `updateTask` rewrites `statusId`
      // to the destination project's equivalent status whenever `projectId`
      // changes, so a combined payload would throw away the status the user
      // picked in the same window.
      if (projectId !== undefined) await tasksService.update({ id: taskId, projectId })
      if (Object.keys(updates).length > 0) {
        await tasksService.update(toTaskUpdateInput(taskId, updates))
      }
      if (completed === true) await tasksService.complete({ id: taskId })
      else if (completed === false) await tasksService.uncomplete(taskId)
    })()
  }, [taskId])

  const handleRemoveGhost = useCallback(() => {
    editor.removeBlocks([block])
  }, [block, editor])

  const openDetail = useCallback(() => openTaskDetail(taskId), [openTaskDetail, taskId])

  const handleOpenRelatedItem = useCallback(
    (ref: RelatedRef, itemTitle: string | null) => {
      if (ref.kind === 'canvas') {
        openTab(canvasTabData({ id: ref.id, title: itemTitle }, tCommon('canvas.untitled')))
        return
      }
      void openRelatedVaultItem(ref.id, openTab)
    },
    [openTab, tCommon]
  )

  const navigateArrow = useMemo(
    () => (
      <button
        type="button"
        onClick={openDetail}
        className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 group-focus/taskblock:opacity-100 focus-visible:opacity-100 transition-opacity hover:bg-accent/80"
        title={tPhaseF(
          'phaseF.componentsNoteContentAreaTaskBlockTaskBlockRenderer.openInTaskPanel'
        )}
      >
        <ArrowUpRight className="size-3 text-muted-foreground" />
      </button>
    ),
    [tPhaseF, openDetail]
  )

  // Keys on the block itself, never on a field inside it or a popover that
  // React bubbles up from its portal.
  const handleRowKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!task) return
      const target = e.target as HTMLElement
      if (!e.currentTarget.contains(target)) return
      if (target.closest('input, textarea, [contenteditable="true"]')) return

      const onBlock = target === e.currentTarget
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        openDetail()
        return
      }
      if (onBlock && e.key === 'Enter') {
        e.preventDefault()
        setIsEditingTitle(true)
        return
      }
      if (onBlock && e.key === 'Escape') {
        e.preventDefault()
        e.currentTarget.blur()
        return
      }
      const property = resolvePropertyShortcut(e)
      if (!property) return
      e.preventDefault()
      e.stopPropagation()
      setOpenProperty(property)
    },
    [task, openDetail]
  )

  // A click on the row's own surface (the gaps between its controls) selects
  // the task; a click on a control is that control's.
  const handleRowClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!task) return
      // React bubbles clicks out of portals too: a pick in the `+` menu or a
      // click inside a chip's picker arrives here. Focusing the row then would
      // pull focus out of the picker that just opened and close it.
      if (!e.currentTarget.contains(e.target as Node)) return
      const interactive = (e.target as HTMLElement).closest(INTERACTIVE_SELECTOR)
      if (interactive && interactive !== e.currentTarget.firstElementChild) return
      focusRowSoon()
    },
    [task, focusRowSoon]
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
        className="grow shrink min-w-24 bg-transparent text-[13px] font-medium outline-none text-foreground/90 placeholder:text-muted-foreground"
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
      // A real <button>, not a span: tiptap's NodeView.stopEvent hands button
      // mousedowns to us, so ProseMirror never NodeSelects the block on the way
      // to the title input, which flashed its selection ring.
      // `data-task-title-trigger` is what ContentArea's Backspace guard clicks
      // to move the caret into this title.
      <button
        type="button"
        data-task-title-trigger=""
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
          'grow shrink min-w-24 truncate cursor-text text-start',
          'text-[13px] font-medium',
          isEmpty
            ? 'text-muted-foreground/70 italic'
            : isCompleted
              ? 'text-muted-foreground/60 line-through decoration-1 [text-underline-position:from-font]'
              : 'text-foreground/90'
        )}
      >
        {isEmpty ? 'Task name…' : resolvedTitle}
      </button>
    )
  }, [displayTask?.title, title, isCompleted])

  // --- Render states ---

  if (isDeleted) {
    return (
      <div
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
  // A block with no id at all is a draft whose row is still being created, not
  // the dead block #1907 was about (that one carries a `{task:<id>}` pointing
  // at nothing). Its controls are live: what the user picks is queued and
  // applied when the id arrives, which is the whole point of the queue above.
  const isDraft = !taskId

  if (!project) {
    return (
      <div
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

  const reminderSet = displayTask ? hasActiveReminder(displayTask.id) : false
  const shorthandPreview = quickAddEdit ? (
    <QuickAddPreview
      changes={quickAddEdit.changes}
      projects={projects}
      existingTags={displayTask?.tags ?? []}
    />
  ) : null

  // Set properties as chips, plus a dashed preview of shorthand being typed. A
  // draft or an unresolved block has no row to write to yet, so it gets the
  // preview alone.
  const meta = displayTask ? (
    <>
      <TaskBlockProperties
        task={displayTask}
        isCompleted={isCompleted}
        hasActiveReminder={reminderSet}
        hostNoteId={hostNoteId}
        projectColor={project.color}
        onUpdate={handleUpdate}
        onDescriptionChange={handleDescriptionChange}
        onTagsChange={handleTagsChange}
        onOpenRelatedItem={handleOpenRelatedItem}
        open={openProperty}
        onOpenChange={handlePropertyOpenChange}
      />
      {shorthandPreview}
    </>
  ) : (
    shorthandPreview
  )

  const actions = displayTask ? (
    <div className="flex shrink-0 items-center gap-1">
      <AddPropertyMenu
        items={missingTaskProperties({
          task: displayTask,
          hasActiveReminder: reminderSet,
          hostNoteId
        })}
        onPick={(id) => handlePropertyOpenChange(id, true)}
        className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 group-focus/taskblock:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
      />
      {navigateArrow}
    </div>
  ) : null

  return (
    <div contentEditable={false} className="w-full outline-none [&_*]:outline-none">
      <style>{BLOCKNOTE_OVERRIDES}</style>
      {/* The block's own focus target: selected-but-not-editing, where the
          property keys live. Mouse and Esc reach it; keyboard users get the
          same keys from the title, which is in the tab order. */}
      <div
        ref={rowRef}
        tabIndex={-1}
        role="group"
        aria-label={rowTask.title}
        aria-keyshortcuts="S P Shift+P D Shift+D R H L E Shift+L"
        onKeyDown={handleRowKeyDown}
        onClick={handleRowClick}
        className={cn(
          'group/taskblock rounded-md transition-colors',
          'focus:bg-surface-active/60',
          parentTaskId && 'ms-7'
        )}
      >
        <TaskRow
          task={rowTask}
          project={project}
          projects={projects}
          isCompleted={isCompleted}
          showProjectBadge
          interactive={hasResolvedTask || isDraft}
          onToggleComplete={(...args) => void handleToggleComplete(...args)}
          onUpdateTask={(...args) => void handleUpdateTask(...args)}
          onProjectChange={(...args) => void handleProjectChange(...args)}
          actions={actions}
          meta={meta}
          pickerControl={{ open: openProperty, onOpenChange: handlePropertyOpenChange }}
          renderTitle={isEditingTitle ? titleInput : clickableTitle}
          className="px-0"
        />
      </div>
    </div>
  )
}
