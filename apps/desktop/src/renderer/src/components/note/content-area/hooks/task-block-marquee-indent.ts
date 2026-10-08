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
 * `indentTaskBlock` moves a block into its previous sibling's `children[]` and
 * fires an async `tasksService.update`. `outdentTaskBlock` lifts a block out of
 * its parent's `children[]` and inserts it immediately after the parent. Below
 * one level is allowed only with `tasks.nestedSubtasks` on, as main's
 * `checkParent` allows it.
 *
 * Both helpers are pure in the sense that they have no refs or hook state.
 * They read `editor.document` fresh on each call, so callers may invoke them
 * in loops without worrying about stale indices — `editor.replaceBlocks` is
 * synchronous and the next call sees the updated doc.
 */

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

export interface TaskIndentOptions {
  /**
   * The `tasks.nestedSubtasks` setting. Off keeps the one-level rule: only a
   * top-level task without subtasks moves under a top-level task.
   */
  nested: boolean
  /** A title the block's props do not hold yet (the title input's live value). */
  title?: string
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

  const newParentTaskId = prev.props.taskId as string
  const movedChild: DocBlock = {
    ...block,
    props: {
      ...block.props,
      ...(options.title !== undefined ? { title: options.title } : {}),
      parentTaskId: newParentTaskId
    }
  }
  const newParent: DocBlock = {
    ...prev,
    children: [...(prev.children ?? []), movedChild]
  }

  try {
    editor.replaceBlocks([prev, block], [newParent])
  } catch (err) {
    log.debug('replaceBlocks failed during indent', blockId, err)
    return { kind: 'skipped', id: blockId, reason: 'block-not-found' }
  }

  // A draft has no row yet; its create reads `parentTaskId` off the block.
  if (block.props?.taskId) {
    void tasksService
      .update({ id: block.props.taskId as string, parentId: newParentTaskId })
      .catch((err) => log.warn('tasks.update failed during indent', err))
  }

  return { kind: 'indented', id: blockId, newParentTaskId }
}

/**
 * Promote a single nested taskBlock one level: remove it from its parent's
 * `children[]` and insert it as the parent's next sibling, under the parent's
 * own parent task when there is one. Persists via `tasksService.update`.
 */
export function outdentTaskBlock(
  editor: any,
  blockId: string,
  options: Pick<TaskIndentOptions, 'title'> = {}
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

  const child = location.siblings[location.index]
  const grandparent = locateBlock(doc, parent.id)?.parent ?? null
  const newParentTaskId =
    grandparent?.type === 'taskBlock' && grandparent.props?.taskId
      ? (grandparent.props.taskId as string)
      : ''

  const remainingChildren = (parent.children ?? []).filter((c) => c?.id !== blockId)
  const newParent: DocBlock = { ...parent, children: remainingChildren }
  const promotedSelf: DocBlock = {
    ...child,
    props: {
      ...child.props,
      ...(options.title !== undefined ? { title: options.title } : {}),
      parentTaskId: newParentTaskId
    }
  }

  try {
    editor.replaceBlocks([parent], [newParent, promotedSelf])
  } catch (err) {
    log.debug('replaceBlocks failed during outdent', blockId, err)
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  if (child.props?.taskId) {
    void tasksService
      .update({ id: child.props.taskId as string, parentId: newParentTaskId || null })
      .catch((err) => log.warn('tasks.update failed during outdent', err))
  }

  return { kind: 'outdented', id: blockId }
}
