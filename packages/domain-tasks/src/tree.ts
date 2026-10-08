/**
 * The task hierarchy at any depth, built from the `parentId` pointers alone.
 *
 * `parentId` syncs as an ordinary last-writer-wins field, so two devices can
 * re-parent concurrently and leave a loop (A under B on one, B under A on the
 * other). Every reader goes through this tree, which breaks such a loop
 * deterministically: the member with the smallest id is treated as top level.
 * The Rust core applies the same rule (`memry-core/src/domain/task_tree.rs`).
 *
 * A task whose parent is missing (deleted elsewhere, or not loaded) keeps that
 * dangling pointer: it is neither a root nor anyone's child, so it renders
 * nowhere, as it always has.
 */

export interface TreeTask {
  id: string
  parentId: string | null
}

export interface TaskTree<T extends TreeTask> {
  get(id: string): T | undefined
  /** The parent the tree uses: `null` for a root, including a broken loop's root. */
  parentOf(id: string): string | null
  /** Direct children, in input order. */
  childrenOf(id: string): T[]
  /** Tasks the tree treats as top level, in input order. */
  roots: T[]
  /** Every task below `id`, depth first, children in input order. */
  descendantIds(id: string): string[]
  /** `id`'s ancestors, nearest first. */
  ancestorIds(id: string): string[]
  /** 0 for a root. */
  depth(id: string): number
}

export function buildTaskTree<T extends TreeTask>(tasks: readonly T[]): TaskTree<T> {
  const byId = new Map<string, T>()
  for (const task of tasks) byId.set(task.id, task)

  const loopRoots = findLoopRoots(byId)
  const parentOf = (id: string): string | null => {
    const task = byId.get(id)
    if (!task || task.parentId === null || task.parentId === id || loopRoots.has(id)) return null
    return task.parentId
  }

  const children = new Map<string, T[]>()
  const roots: T[] = []
  for (const task of tasks) {
    const parentId = parentOf(task.id)
    if (parentId === null) {
      roots.push(task)
      continue
    }
    const siblings = children.get(parentId)
    if (siblings) siblings.push(task)
    else children.set(parentId, [task])
  }

  const childrenOf = (id: string): T[] => children.get(id) ?? []

  const descendantIds = (id: string): string[] => {
    const out: string[] = []
    const walk = (parentId: string): void => {
      for (const child of childrenOf(parentId)) {
        out.push(child.id)
        walk(child.id)
      }
    }
    walk(id)
    return out
  }

  const ancestorIds = (id: string): string[] => {
    const out: string[] = []
    let current = parentOf(id)
    while (current !== null && byId.has(current)) {
      out.push(current)
      current = parentOf(current)
    }
    return out
  }

  return {
    get: (id) => byId.get(id),
    parentOf,
    childrenOf,
    roots,
    descendantIds,
    ancestorIds,
    depth: (id) => ancestorIds(id).length
  }
}

/** The smallest id of every `parentId` loop. */
function findLoopRoots(byId: ReadonlyMap<string, TreeTask>): Set<string> {
  const loopRoots = new Set<string>()
  const settled = new Set<string>()

  for (const start of byId.keys()) {
    if (settled.has(start)) continue
    const path: string[] = []
    const onPath = new Map<string, number>()
    let current: string | null = start
    while (current !== null && byId.has(current) && !settled.has(current)) {
      const seenAt = onPath.get(current)
      if (seenAt !== undefined) {
        const loop = path.slice(seenAt)
        loopRoots.add(loop.reduce((min, id) => (id < min ? id : min)))
        break
      }
      onPath.set(current, path.length)
      path.push(current)
      const parentId: string | null = byId.get(current)?.parentId ?? null
      current = parentId === current ? null : parentId
    }
    for (const id of path) settled.add(id)
  }

  return loopRoots
}

export type ParentRejection = 'self' | 'missing' | 'other-project' | 'own-branch' | 'too-deep'

/** What `checkParent` needs: the tree in the renderer, the repository in main. */
export interface ParentLookup {
  get(id: string): { parentId: string | null; projectId: string } | undefined
  hasChildren(id: string): boolean
}

/**
 * Whether `taskId` (null for a task not created yet) may sit under `parentId`.
 * With `allowNested` off, the one-level rule of builds before nested subtasks
 * still holds: the parent must be top level and the task must have no subtasks.
 */
export function checkParent(
  lookup: ParentLookup,
  taskId: string | null,
  parentId: string,
  projectId: string,
  allowNested: boolean
): ParentRejection | null {
  if (taskId === parentId) return 'self'
  const parent = lookup.get(parentId)
  if (!parent) return 'missing'
  if (parent.projectId !== projectId) return 'other-project'
  const seen = new Set<string>([parentId])
  let current = parent.parentId
  while (current !== null && !seen.has(current)) {
    if (current === taskId) return 'own-branch'
    seen.add(current)
    current = lookup.get(current)?.parentId ?? null
  }
  if (!allowNested) {
    if (parent.parentId !== null) return 'too-deep'
    if (taskId !== null && lookup.hasChildren(taskId)) return 'too-deep'
  }
  return null
}

export function treeParentLookup<T extends TreeTask & { projectId: string }>(
  tree: TaskTree<T>
): ParentLookup {
  return {
    get: (id) => {
      const task = tree.get(id)
      return task ? { parentId: tree.parentOf(id), projectId: task.projectId } : undefined
    },
    hasChildren: (id) => tree.childrenOf(id).length > 0
  }
}
