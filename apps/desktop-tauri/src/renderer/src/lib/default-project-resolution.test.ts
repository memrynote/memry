import { describe, it, expect } from 'vitest'
import {
  resolveModalDefaultProject,
  resolveInitialViewProject,
  resolveQuickAddProject
} from './default-project-resolution'
import type { Project, Status } from '@/data/tasks-data'

const TODO: Status = { id: 's-todo', name: 'To Do', color: '#666', type: 'todo', order: 0 }
const DONE: Status = { id: 's-done', name: 'Done', color: '#0f0', type: 'done', order: 1 }

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'personal',
    name: 'Personal',
    description: '',
    icon: 'User',
    color: '#6366f1',
    statuses: [TODO, DONE],
    isDefault: true,
    isArchived: false,
    createdAt: new Date(),
    taskCount: 0,
    ...overrides
  }
}

const PERSONAL = makeProject()
const WORK = makeProject({ id: 'work', name: 'Work', isDefault: false })
const LEARNING = makeProject({ id: 'learning', name: 'Learning', isDefault: false })
const PROJECTS = [PERSONAL, WORK, LEARNING]

describe('resolveModalDefaultProject', () => {
  it('uses selected project when in project view', () => {
    // #given
    const context = { selectedType: 'project', selectedProject: WORK }
    // #when
    const result = resolveModalDefaultProject(context, 'learning')
    // #then — selected project takes priority over setting
    expect(result).toBe('work')
  })

  it('uses setting when not in project view', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveModalDefaultProject(context, 'work')
    // #then
    expect(result).toBe('work')
  })

  it('falls back to personal when no setting and not in project view', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveModalDefaultProject(context, null)
    // #then
    expect(result).toBe('personal')
  })

  it('ignores selectedProject when selectedType is not project', () => {
    // #given — selectedType is 'today' but selectedProject somehow set
    const context = { selectedType: 'today', selectedProject: WORK }
    // #when
    const result = resolveModalDefaultProject(context, 'learning')
    // #then — should use setting, not selectedProject
    expect(result).toBe('learning')
  })

  it('uses setting even when it points to a non-existent project', () => {
    // #given — user deleted the project but setting still references it
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveModalDefaultProject(context, 'deleted-project-id')
    // #then — resolution layer does not validate; consumer handles missing project
    expect(result).toBe('deleted-project-id')
  })

  it('uses filtered project when on a view with dropdown filter active', () => {
    // #given — user is on "All" tab with project dropdown set to Work
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveModalDefaultProject(context, 'learning', 'work')
    // #then — dropdown filter takes priority over default setting
    expect(result).toBe('work')
  })

  it('sidebar project takes priority over dropdown filter', () => {
    // #given — both sidebar and dropdown are set (edge case)
    const context = { selectedType: 'project', selectedProject: LEARNING }
    // #when
    const result = resolveModalDefaultProject(context, null, 'work')
    // #then — sidebar wins
    expect(result).toBe('learning')
  })

  it('falls through to setting when filtered project is null', () => {
    // #given — dropdown shows "All Projects" (null)
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveModalDefaultProject(context, 'work', null)
    // #then
    expect(result).toBe('work')
  })
})

describe('resolveQuickAddProject', () => {
  it('uses parsed project when explicitly provided', () => {
    // #given — user typed #Work in quick add
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject('work', context, 'learning', PROJECTS)
    // #then
    expect(result).toBe('work')
  })

  it('uses selected project when no parsed project and in project view', () => {
    // #given
    const context = { selectedType: 'project', selectedProject: WORK }
    // #when
    const result = resolveQuickAddProject(null, context, 'learning', PROJECTS)
    // #then
    expect(result).toBe('work')
  })

  it('uses setting when no parsed project and not in project view', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(null, context, 'work', PROJECTS)
    // #then
    expect(result).toBe('work')
  })

  it('uses isDefault project when no parsed, no view, no setting', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(null, context, null, PROJECTS)
    // #then — Personal has isDefault: true
    expect(result).toBe('personal')
  })

  it('falls back to hardcoded personal when nothing matches', () => {
    // #given — no default project in the list
    const noDefaultProjects = PROJECTS.map((p) => ({ ...p, isDefault: false }))
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(null, context, null, noDefaultProjects)
    // #then
    expect(result).toBe('personal')
  })

  it('treats undefined parsed project same as null', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(undefined, context, 'work', PROJECTS)
    // #then
    expect(result).toBe('work')
  })

  it('treats empty string parsed project as falsy (uses fallback)', () => {
    // #given
    const context = { selectedType: 'all', selectedProject: null }
    // #when — empty string is falsy
    const result = resolveQuickAddProject('', context, 'work', PROJECTS)
    // #then
    expect(result).toBe('work')
  })

  it('selected project takes priority over setting', () => {
    // #given
    const context = { selectedType: 'project', selectedProject: LEARNING }
    // #when
    const result = resolveQuickAddProject(null, context, 'work', PROJECTS)
    // #then
    expect(result).toBe('learning')
  })

  it('uses filtered project when on a view with dropdown filter active', () => {
    // #given — user is on "Today" tab with project dropdown filtering to Work
    const context = { selectedType: 'today', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(null, context, 'learning', PROJECTS, 'work')
    // #then — dropdown filter takes priority over default setting
    expect(result).toBe('work')
  })

  it('parsed project takes priority over dropdown filter', () => {
    // #given — user typed #learning in quick-add, dropdown is filtering Work
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject('learning', context, null, PROJECTS, 'work')
    // #then — explicit user input wins
    expect(result).toBe('learning')
  })

  it('sidebar project takes priority over dropdown filter', () => {
    // #given — on sidebar project Learning, dropdown somehow set to Work
    const context = { selectedType: 'project', selectedProject: LEARNING }
    // #when
    const result = resolveQuickAddProject(null, context, null, PROJECTS, 'work')
    // #then — sidebar wins
    expect(result).toBe('learning')
  })

  it('falls through to setting when filtered project is null', () => {
    // #given — dropdown shows "All Projects"
    const context = { selectedType: 'all', selectedProject: null }
    // #when
    const result = resolveQuickAddProject(null, context, 'work', PROJECTS, null)
    // #then
    expect(result).toBe('work')
  })
})

describe('resolveInitialViewProject', () => {
  it('returns defaultProjectId when set and project exists', () => {
    // #given — user configured "work" as default in settings
    // #when
    const result = resolveInitialViewProject('view', 'work', PROJECTS)
    // #then — dropdown should pre-select Work
    expect(result).toBe('work')
  })

  it('returns null when no setting configured', () => {
    // #given — no default project in settings
    // #when
    const result = resolveInitialViewProject('view', null, PROJECTS)
    // #then — show "All Projects"
    expect(result).toBeNull()
  })

  it('returns null when already in project tab', () => {
    // #given — user opened a project-specific tab
    // #when
    const result = resolveInitialViewProject('project', 'work', PROJECTS)
    // #then — don't override the tab's own project selection
    expect(result).toBeNull()
  })

  it('returns null when setting points to archived project', () => {
    // #given — default project was archived
    const withArchived = [
      ...PROJECTS,
      makeProject({ id: 'old', name: 'Old', isDefault: false, isArchived: true })
    ]
    // #when
    const result = resolveInitialViewProject('view', 'old', withArchived)
    // #then — don't pre-select an archived project
    expect(result).toBeNull()
  })

  it('returns null when setting points to deleted project', () => {
    // #given — project was deleted but setting still references it
    // #when
    const result = resolveInitialViewProject('view', 'deleted-id', PROJECTS)
    // #then — project not found → show "All Projects"
    expect(result).toBeNull()
  })
})
