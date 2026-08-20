import { describe, it, expect } from 'vitest'
import {
  BOOKMARK_SORT_DRAG_TYPE,
  PROJECT_SORT_DRAG_TYPE,
  resolveProjectReorderTarget
} from './sidebar-drag-types'

const projectIds = ['work', 'fitness', 'home'] as const

// No default for activeType: passing `undefined` to a defaulted parameter would
// silently substitute the project type and make the "untyped drag" case pass
// for the wrong reason.
const resolveTyped = (over: string, active = 'home') =>
  resolveProjectReorderTarget({
    activeType: PROJECT_SORT_DRAG_TYPE,
    activeId: active,
    overId: over,
    projectIds
  })

const resolveWithType = (activeType: unknown, over: string) =>
  resolveProjectReorderTarget({ activeType, activeId: 'home', overId: over, projectIds })

describe('project reorder target', () => {
  it('resolves a drop on another project row', () => {
    expect(resolveTyped('work')).toEqual({ from: 2, to: 0 })
  })

  // The regression this exists for: a project row registers a sortable (`work`)
  // AND a task drop target (`project-work`). When the droppable won the
  // collision the reorder found no match, and the drop fell through to the
  // task-move path — which announced "0 tasks moved to Fitness".
  it('resolves a drop that landed on the row task drop target', () => {
    expect(resolveTyped('project-work')).toEqual({ from: 2, to: 0 })
    expect(resolveTyped('project-fitness')).toEqual({ from: 2, to: 1 })
  })

  it('ignores a drag that is not a project reorder', () => {
    expect(resolveWithType('task', 'work')).toBeNull()
    expect(resolveWithType(undefined, 'work')).toBeNull()
    expect(resolveWithType(BOOKMARK_SORT_DRAG_TYPE, 'work')).toBeNull()
  })

  it('ignores a drop on itself, by either id form', () => {
    expect(resolveTyped('home')).toBeNull()
    expect(resolveTyped('project-home')).toBeNull()
  })

  it('ignores a drop on something that is not a project', () => {
    expect(resolveTyped('trash')).toBeNull()
    expect(resolveTyped('project-deleted')).toBeNull()
  })
})
