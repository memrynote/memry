/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task-block indent/outdent primitives: the one owner of Tab and Shift+Tab on a
 * task block, whether from its title input, a marquee, or a multi-block
 * selection.
 *
 * Task blocks (`content: 'none'` custom blocks) cannot use BlockNote's
 * `nestBlock` / `unnestBlock` — those assume a valid TextSelection inside a
 * textblock and corrupt the ReactNodeView when called on a non-textblock,
 * crashing the next iteration of `syncNodeSelection.descAt`. Instead, task
 * hierarchy is expressed via the `parentTaskId` prop + the DB `parentId`
 * column. The tree position inside `parent.children[]` is also maintained so
 * serialization to markdown produces correctly-nested output.
 *
 * The note's block tree holds at most `MAX_NOTE_TASK_DEPTH` task levels (see
 * that constant for the compat contract). A task deeper in the DB sits in its
 * top-level ancestor's `children[]` like a subtask, with `parentTaskId` naming
 * that ancestor, and is indented by its DB depth (`noteTaskDepth`). Tab and
 * Shift+Tab on such a row change only its DB parent, and reorder the row with
 * the rows below it inside the same list.
 *
 * `indentTaskBlock` moves a top-level block into its previous sibling's
 * `children[]`, or re-parents a listed task under the row above it, and fires
 * an async `tasksService.update`. `outdentTaskBlock` lifts a listed block out
 * one level. Below one level is allowed only with `tasks.nestedSubtasks` on,
 * as main's `checkParent` allows it.
 *
 * Both helpers are pure in the sense that they have no refs or hook state.
 * They read `editor.document` fresh on each call, so callers may invoke them
 * in loops without worrying about stale indices — `editor.replaceBlocks` is
 * synchronous and the next call sees the updated doc.
 */

import { capTaskTreeDepth } from '@memry/shared/task-block'
import { tasksService } from '@/services/tasks-service'
import { createLogger } from '@/lib/logger'

const log = createLogger('Marquee:TaskIndent')

export type BlockKind = 'textblock' | 'taskBlock' | 'other'

export interface ClassifiedBlocks {
  textblocks: string[]
  taskBlocks: string[]
  other: string[]
}

export type TaskIndentOutcome =
  | { kind: 'indented'; id: string; newParentTaskId: string }
  | { kind: 'outdented'; id: string }
  | {
      kind: 'skipped'
      id: string
      reason:
        | 'already-nested'
        | 'no-prev-task-sibling'
        | 'not-nested'
        | 'parent-not-found'
        | 'block-not-found'
    }

interface DocBlock {
  id: string
  type: string
  props?: Record<string, any>
  children?: DocBlock[]
}

/**
 * Classify each id into exactly one bucket by walking the PM doc once.
 * Rules:
 *   - outer blockContainer's first child `type.isTextblock === true` → textblocks
 *   - outer blockContainer's type name === 'taskBlock' → taskBlocks
 *   - anything else (file, youtubeEmbed, etc.) → other
 */
export function classifyBlocks(editor: any, ids: readonly string[]): ClassifiedBlocks {
  const out: ClassifiedBlocks = { textblocks: [], taskBlocks: [], other: [] }
  const view = editor?.prosemirrorView
  if (!view || ids.length === 0) return out

  const wanted = new Set(ids)
  const kindById = new Map<string, BlockKind>()

  view.state.doc.descendants((node: any) => {
    if (kindById.size === wanted.size) return false
    if (node.type.name !== 'blockContainer') return true
    const id = node.attrs?.id as string | undefined
    if (!id || !wanted.has(id) || kindById.has(id)) return true
    const inner = node.firstChild
    if (inner && inner.type.isTextblock) {
      kindById.set(id, 'textblock')
    } else if (inner && inner.type.name === 'taskBlock') {
      kindById.set(id, 'taskBlock')
    } else {
      kindById.set(id, 'other')
    }
    return true
  })

  for (const id of ids) {
    const kind = kindById.get(id) ?? 'other'
    if (kind === 'textblock') out.textblocks.push(id)
    else if (kind === 'taskBlock') out.taskBlocks.push(id)
    else out.other.push(id)
  }
  return out
}

/** Where a block sits: the list holding it and the block that list belongs to. */
interface BlockLocation {
  siblings: DocBlock[]
  index: number
  /** Null at the top level of the document. */
  parent: DocBlock | null
}

function locateBlock(
  list: DocBlock[],
  id: string,
  parent: DocBlock | null = null
): BlockLocation | null {
  for (let index = 0; index < list.length; index += 1) {
    const block = list[index]
    if (block?.id === id) return { siblings: list, index, parent }
    const found = block?.children?.length ? locateBlock(block.children, id, block) : null
    if (found) return found
  }
  return null
}

function hasTaskChildren(block: DocBlock): boolean {
  return (block.children ?? []).some((child) => child?.type === 'taskBlock')
}

/** The DB parent of each task in the note, read and written synchronously. */
export interface TaskParents {
  /** Null for a top-level task, undefined when the task is not known. */
  get(taskId: string): string | null | undefined
  set(taskId: string, parentId: string | null): void
}

export const NO_TASK_PARENTS: TaskParents = { get: () => undefined, set: () => {} }

const MAX_PARENT_CHAIN = 64

/** Levels from `taskId` up to `ancestorId` by DB parents: 1 for a direct child. Null when the chain does not reach it. */
export function taskDepthBelow(
  taskId: string,
  ancestorId: string,
  parents: TaskParents
): number | null {
  let current = taskId
  for (let depth = 1; depth <= MAX_PARENT_CHAIN; depth += 1) {
    const parentId = parents.get(current)
    if (!parentId) return null
    if (parentId === ancestorId) return depth
    current = parentId
  }
  return null
}

/** How deep a listed task block shows under its tree parent: its DB depth, 1 when unknown. */
export function noteTaskDepth(
  taskId: string | undefined,
  treeParentId: string,
  parents: TaskParents
): number {
  return (taskId && taskDepthBelow(taskId, treeParentId, parents)) || 1
}

/** End (exclusive) of the row at `index` and the rows after it shown deeper than it. */
function rowRunEnd(
  siblings: DocBlock[],
  index: number,
  treeParentId: string,
  parents: TaskParents
): number {
  const depth = noteTaskDepth(siblings[index].props?.taskId, treeParentId, parents)
  let end = index + 1
  while (
    end < siblings.length &&
    siblings[end]?.type === 'taskBlock' &&
    noteTaskDepth(siblings[end].props?.taskId, treeParentId, parents) > depth
  ) {
    end += 1
  }
  return end
}

function withTitle(block: DocBlock, title: string | undefined): DocBlock {
  return title === undefined ? block : { ...block, props: { ...block.props, title } }
}

function persistParent(taskId: string, parentId: string | null, parents: TaskParents): void {
  parents.set(taskId, parentId)
  void tasksService
    .update({ id: taskId, parentId })
    .catch((err) => log.warn('tasks.update failed moving a task block', err))
}

/**
 * Lift task blocks below `MAX_NOTE_TASK_DEPTH` in the top-level tree holding
 * `blockId` to that depth, each right after its old tree parent. Called once a
 * block nested there has its row, whose DB parent then keeps the depth.
 */
export function capNoteTaskTree(editor: any, blockId: string): void {
  const doc = (editor?.document ?? []) as DocBlock[]
  const top = doc.find(
    (block) => block.id === blockId || locateBlock(block.children ?? [], blockId)
  )
  if (top?.type !== 'taskBlock') return
  const capped = capTaskTreeDepth(top)
  if (capped !== top) editor.replaceBlocks([top], [capped])
}

export interface TaskIndentOptions {
  /**
   * The `tasks.nestedSubtasks` setting. Off keeps the one-level rule: only a
   * top-level task without subtasks moves under a top-level task.
   */
  nested: boolean
  /** A title the block's props do not hold yet (the title input's live value). */
  title?: string
  parents?: TaskParents
}

/**
 * Demote a single taskBlock one level: move it into its previous sibling's
 * `children[]` and persist via `tasksService.update`. Returns a structured
 * outcome so callers can log skipped reasons.
 */
export function indentTaskBlock(
  editor: any,
  blockId: string,
  options: TaskIndentOptions
): TaskIndentOutcome {
  const doc = (editor?.document ?? []) as DocBlock[]
  const location = locateBlock(doc, blockId)
  if (!location) return { kind: 'skipped', id: blockId, reason: 'block-not-found' }

  const block = location.siblings[location.index]
  if (
    !options.nested &&
    (location.parent !== null || block.props?.parentTaskId || hasTaskChildren(block))
  ) {
    return { kind: 'skipped', id: blockId, reason: 'already-nested' }
  }

  const prev = location.index > 0 ? location.siblings[location.index - 1] : null
  if (prev?.type !== 'taskBlock' || !prev.props?.taskId) {
    return { kind: 'skipped', id: blockId, reason: 'no-prev-task-sibling' }
  }
  if (!options.nested && prev.props.parentTaskId) {
    return { kind: 'skipped', id: blockId, reason: 'already-nested' }
  }

  const parents = options.parents ?? NO_TASK_PARENTS
  const treeParentId = location.parent?.props?.taskId as string | undefined
  if (location.parent?.type === 'taskBlock' && treeParentId && block.props?.taskId) {
    return indentListedTask(editor, location, treeParentId, parents, options.title)
  }

  const newParentTaskId = prev.props.taskId as string
  const titled = withTitle(block, options.title)
  const movedChild: DocBlock = {
    ...titled,
    props: { ...titled.props, parentTaskId: newParentTaskId }
  }
  // The moved block's own subtasks come along as rows of the same list.
  const newParent = capTaskTreeDepth<DocBlock>({
    ...prev,
    children: [...(prev.children ?? []), movedChild]
  })

  try {
    editor.replaceBlocks([prev, block], [newParent])
  } catch (err) {
    log.debug('replaceBlocks failed during indent', blockId, err)
    return { kind: 'skipped', id: blockId, reason: 'block-not-found' }
  }

  // A draft has no row yet; its create reads `parentTaskId` off the block.
  if (block.props?.taskId) persistParent(block.props.taskId as string, newParentTaskId, parents)

  return { kind: 'indented', id: blockId, newParentTaskId }
}

/**
 * Tab on a task row listed under a top-level task: its DB parent becomes the
 * row above at its own depth. The block tree does not change.
 */
function indentListedTask(
  editor: any,
  location: BlockLocation,
  treeParentId: string,
  parents: TaskParents,
  title: string | undefined
): TaskIndentOutcome {
  const block = location.siblings[location.index]
  const prev = location.siblings[location.index - 1]
  const depth = noteTaskDepth(block.props?.taskId, treeParentId, parents)
  let prevDepth = noteTaskDepth(prev.props?.taskId, treeParentId, parents)
  if (prevDepth < depth) return { kind: 'skipped', id: block.id, reason: 'already-nested' }
  let newParentTaskId = prev.props?.taskId as string
  for (; prevDepth > depth; prevDepth -= 1) {
    const up = parents.get(newParentTaskId)
    if (!up) return { kind: 'skipped', id: block.id, reason: 'parent-not-found' }
    newParentTaskId = up
  }
  if (title !== undefined) editor.updateBlock(block, { props: { title } })
  persistParent(block.props?.taskId as string, newParentTaskId, parents)
  return { kind: 'indented', id: block.id, newParentTaskId }
}

/**
 * Promote a single nested taskBlock one level: remove it from its parent's
 * `children[]` and insert it as the parent's next sibling, under the parent's
 * own parent task when there is one. Persists via `tasksService.update`.
 */
export function outdentTaskBlock(
  editor: any,
  blockId: string,
  options: Pick<TaskIndentOptions, 'title' | 'parents'> = {}
): TaskIndentOutcome {
  const doc = (editor?.document ?? []) as DocBlock[]
  const location = locateBlock(doc, blockId)
  if (!location) return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }

  const parent = location.parent
  // Already at the top level: the common case of Shift+Tab on a top-level
  // task. Silent no-op.
  if (!parent) return { kind: 'skipped', id: blockId, reason: 'not-nested' }
  if (parent.type !== 'taskBlock' || !parent.props?.taskId) {
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  const parents = options.parents ?? NO_TASK_PARENTS
  const treeParentId = parent.props.taskId as string
  const child = location.siblings[location.index]
  if (noteTaskDepth(child.props?.taskId, treeParentId, parents) > 1) {
    return outdentListedTask(editor, location, parent, parents, options.title)
  }

  const grandparent = locateBlock(doc, parent.id)?.parent ?? null
  const newParentTaskId =
    grandparent?.type === 'taskBlock' && grandparent.props?.taskId
      ? (grandparent.props.taskId as string)
      : ''

  // The rows shown under this one leave with it, as its own subtasks.
  const runEnd = rowRunEnd(location.siblings, location.index, treeParentId, parents)
  const carried = location.siblings
    .slice(location.index + 1, runEnd)
    .map((row) => ({ ...row, props: { ...row.props, parentTaskId: child.props?.taskId } }))
  const remainingChildren = location.siblings.filter(
    (_, index) => index < location.index || index >= runEnd
  )
  const newParent: DocBlock = { ...parent, children: remainingChildren }
  const titled = withTitle(child, options.title)
  const promotedSelf: DocBlock = {
    ...titled,
    props: { ...titled.props, parentTaskId: newParentTaskId },
    ...(carried.length > 0 ? { children: [...(child.children ?? []), ...carried] } : {})
  }

  try {
    editor.replaceBlocks([parent], [newParent, promotedSelf])
  } catch (err) {
    log.debug('replaceBlocks failed during outdent', blockId, err)
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  if (child.props?.taskId) {
    persistParent(child.props.taskId as string, newParentTaskId || null, parents)
  }

  return { kind: 'outdented', id: blockId }
}

/**
 * Shift+Tab on a task row shown two or more levels deep: its DB parent becomes
 * its grandparent, and the row with the rows under it moves below the rest of
 * its old parent's rows, so the list reads as the tree.
 */
function outdentListedTask(
  editor: any,
  location: BlockLocation,
  treeParent: DocBlock,
  parents: TaskParents,
  title: string | undefined
): TaskIndentOutcome {
  const treeParentId = treeParent.props?.taskId as string
  const rows = location.siblings
  const block = rows[location.index]
  const taskId = block.props?.taskId as string
  const oldParentId = parents.get(taskId)
  const newParentTaskId = oldParentId ? parents.get(oldParentId) : undefined
  if (!oldParentId || !newParentTaskId) {
    return { kind: 'skipped', id: block.id, reason: 'parent-not-found' }
  }

  const parentIndex = rows.findIndex((row) => row.props?.taskId === oldParentId)
  const ownEnd = rowRunEnd(rows, location.index, treeParentId, parents)
  const parentEnd =
    parentIndex === -1 ? ownEnd : rowRunEnd(rows, parentIndex, treeParentId, parents)
  const moved = [withTitle(block, title), ...rows.slice(location.index + 1, ownEnd)]
  const reordered = [
    ...rows.slice(0, location.index),
    ...rows.slice(ownEnd, parentEnd),
    ...moved,
    ...rows.slice(parentEnd)
  ]
  if (parentEnd > ownEnd || title !== undefined) {
    try {
      editor.replaceBlocks([treeParent], [{ ...treeParent, children: reordered }])
    } catch (err) {
      log.debug('replaceBlocks failed during outdent', block.id, err)
      return { kind: 'skipped', id: block.id, reason: 'parent-not-found' }
    }
  }
  persistParent(taskId, newParentTaskId, parents)
  return { kind: 'outdented', id: block.id }
}
