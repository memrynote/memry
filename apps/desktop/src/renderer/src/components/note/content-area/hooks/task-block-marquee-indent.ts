/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task-block indent/outdent primitives for marquee selection.
 *
 * Task blocks (`content: 'none'` custom blocks) cannot use BlockNote's
 * `nestBlock` / `unnestBlock` — those assume a valid TextSelection inside a
 * textblock and corrupt the ReactNodeView when called on a non-textblock,
 * crashing the next iteration of `syncNodeSelection.descAt`. Instead, task
 * hierarchy is expressed via the `parentTaskId` prop + the DB `parentId`
 * column. The tree position inside `parent.children[]` is also maintained so
 * serialization to markdown produces correctly-nested output.
 *
 * These helpers mirror the single-task Tab handler in
 * `task-block-renderer.tsx:210-284`. `indentTaskBlock` moves a block into its
 * previous top-level sibling's `children[]` and fires an async
 * `tasksService.update`. `outdentTaskBlock` lifts a block out of its parent's
 * `children[]` and inserts it as a top-level sibling immediately after the
 * parent.
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
        | 'no-task-id'
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

function findAtTopLevel(doc: DocBlock[], id: string): number {
  for (let i = 0; i < doc.length; i += 1) {
    if (doc[i]?.id === id) return i
  }
  return -1
}

function findParentOf(doc: DocBlock[], id: string): DocBlock | null {
  for (const top of doc) {
    const children = top?.children
    if (Array.isArray(children) && children.some((c) => c?.id === id)) {
      return top
    }
  }
  return null
}

/**
 * Demote a single taskBlock one level: move it into its previous top-level
 * sibling's `children[]` and persist via `tasksService.update`. Returns a
 * structured outcome so callers can log skipped reasons.
 */
export function indentTaskBlock(editor: any, blockId: string): TaskIndentOutcome {
  const doc = (editor?.document ?? []) as DocBlock[]

  const topIdx = findAtTopLevel(doc, blockId)
  if (topIdx === -1) {
    // Not at top level — either nested inside a parent's children (which
    // means already-nested, since the current model is 2-level) or the
    // block no longer exists.
    const parent = findParentOf(doc, blockId)
    if (parent) return { kind: 'skipped', id: blockId, reason: 'already-nested' }
    return { kind: 'skipped', id: blockId, reason: 'block-not-found' }
  }

  const block = doc[topIdx]
  if (block?.props?.parentTaskId) {
    return { kind: 'skipped', id: blockId, reason: 'already-nested' }
  }
  if (topIdx === 0) {
    return { kind: 'skipped', id: blockId, reason: 'no-prev-task-sibling' }
  }

  const prev = doc[topIdx - 1]
  if (prev?.type !== 'taskBlock' || !prev.props?.taskId) {
    return { kind: 'skipped', id: blockId, reason: 'no-prev-task-sibling' }
  }
  if (!block.props?.taskId) {
    return { kind: 'skipped', id: blockId, reason: 'no-task-id' }
  }

  const newParentTaskId = prev.props.taskId as string
  const movedChild: DocBlock = {
    ...block,
    props: { ...block.props, parentTaskId: newParentTaskId }
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

  void tasksService
    .update({ id: block.props.taskId as string, parentId: newParentTaskId })
    .catch((err) => log.warn('tasks.update failed during indent', err))

  return { kind: 'indented', id: blockId, newParentTaskId }
}

/**
 * Promote a single nested taskBlock one level: remove it from its parent's
 * `children[]` and insert as a top-level sibling immediately after the parent.
 * Persists via `tasksService.update({ parentId: null })`.
 */
export function outdentTaskBlock(editor: any, blockId: string): TaskIndentOutcome {
  const doc = (editor?.document ?? []) as DocBlock[]

  const parent = findParentOf(doc, blockId)
  if (!parent) {
    // Either already at top level (not nested) or doesn't exist. The top
    // level case is the common one — caller selected a top-level task and
    // pressed Shift+Tab. Silent no-op.
    const topIdx = findAtTopLevel(doc, blockId)
    if (topIdx !== -1) return { kind: 'skipped', id: blockId, reason: 'not-nested' }
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  const child = (parent.children ?? []).find((c) => c?.id === blockId)
  if (!child) {
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }
  if (!parent.props?.taskId) {
    // Defensive — the parent is a taskBlock (otherwise findParentOf wouldn't
    // have returned it). If it's missing a taskId, treat as malformed.
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  const remainingChildren = (parent.children ?? []).filter((c) => c?.id !== blockId)
  const newParent: DocBlock = { ...parent, children: remainingChildren }
  const promotedSelf: DocBlock = {
    ...child,
    props: { ...child.props, parentTaskId: '' }
  }

  try {
    editor.replaceBlocks([parent], [newParent, promotedSelf])
  } catch (err) {
    log.debug('replaceBlocks failed during outdent', blockId, err)
    return { kind: 'skipped', id: blockId, reason: 'parent-not-found' }
  }

  if (child.props?.taskId) {
    void tasksService
      .update({ id: child.props.taskId as string, parentId: null })
      .catch((err) => log.warn('tasks.update failed during outdent', err))
  }

  return { kind: 'outdented', id: blockId }
}
