import { EN_BUNDLE } from '@memry/i18n/locales/en-bundle'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  canDeleteStatus,
  createDefaultProject,
  createDefaultStatus,
  defaultStatuses,
  dueDateFilterLabel,
  dueDateFilterOptions,
  generateId,
  quickFilterPresets,
  statusTypeOptions,
  validateProject,
  type DueDateFilterType,
  type Status
} from './tasks-data'

/**
 * The module resolves labels through `getI18n()` at access time, so the mock is
 * a live instance: flipping `language` between two reads is what proves the
 * getters are re-evaluated instead of captured once, and flipping `booted` to
 * false reproduces "a label is read before `createRendererI18n` ran".
 */
const i18n = vi.hoisted(() => ({
  booted: true,
  language: 'en',
  calls: [] as { namespace: string; key: string }[]
}))

vi.mock('react-i18next', () => ({
  getI18n: () =>
    i18n.booted
      ? {
          getFixedT: (_lng: string | null, namespace: string) => (key: string) => {
            i18n.calls.push({ namespace, key })
            return `${namespace}:${key}@${i18n.language}`
          }
        }
      : undefined
}))

const translated = (key: string, language = i18n.language): string => `tasks:${key}@${language}`

const status = (overrides: Partial<Status> = {}): Status => ({
  id: 'todo',
  name: 'To Do',
  color: '#6b7280',
  type: 'todo',
  order: 0,
  ...overrides
})

const todoAndDone = (): Status[] => [
  status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
  status({ id: 'done', name: 'Done', type: 'done', order: 1 })
]

const lookup = (key: string): unknown =>
  key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      EN_BUNDLE.tasks
    )

beforeEach(() => {
  i18n.booted = true
  i18n.language = 'en'
  i18n.calls = []
})

describe('due date filter labels', () => {
  it('resolves every option label through the tasks namespace, in the offered order', () => {
    expect(dueDateFilterOptions.map((option) => [option.value, option.label])).toEqual([
      ['any', translated('filters.dueDate.any')],
      ['none', translated('filters.dueDate.none')],
      ['overdue', translated('filters.dueDate.overdue')],
      ['today', translated('filters.dueDate.today')],
      ['tomorrow', translated('filters.dueDate.tomorrow')],
      ['this-week', translated('filters.dueDate.thisWeek')],
      ['next-week', translated('filters.dueDate.nextWeek')],
      ['this-month', translated('filters.dueDate.thisMonth')],
      ['custom', translated('filters.dueDate.custom')]
    ])
    expect(i18n.calls.every((call) => call.namespace === 'tasks')).toBe(true)
  })

  it('re-reads the label on every access, so a locale switch is picked up', () => {
    // A held reference is what a rendered <option> keeps; if the getter were
    // replaced by an eagerly evaluated string it would freeze at 'en' here.
    const [any, custom] = [dueDateFilterOptions[0], dueDateFilterOptions[8]]
    expect(any.label).toBe(translated('filters.dueDate.any', 'en'))
    expect(custom.label).toBe(translated('filters.dueDate.custom', 'en'))

    i18n.language = 'tr'

    expect(any.label).toBe(translated('filters.dueDate.any', 'tr'))
    expect(custom.label).toBe(translated('filters.dueDate.custom', 'tr'))
    expect(dueDateFilterLabel('today')).toBe(translated('filters.dueDate.today', 'tr'))
  })

  it('falls back to English while i18n is still booting, then upgrades once it is ready', () => {
    i18n.booted = false

    expect(dueDateFilterOptions.map((option) => option.label)).toEqual([
      'Any due date',
      'No due date',
      'Overdue',
      'Today',
      'Tomorrow',
      'This week',
      'Next week',
      'This month',
      'Custom range...'
    ])
    expect(i18n.calls).toEqual([])

    i18n.booted = true

    expect(dueDateFilterOptions[3].label).toBe(translated('filters.dueDate.today'))
  })

  it('falls back to the raw type for a filter type this build does not know', () => {
    // Saved filters are persisted and synced, so an older/newer build can hand
    // back a type that is not in the table. It must not throw.
    expect(dueDateFilterLabel('someday' as DueDateFilterType)).toBe('someday')
    expect(i18n.calls).toEqual([])
  })
})

describe('status type options', () => {
  it('translates each status type label', () => {
    expect(statusTypeOptions.map((option) => [option.value, option.label])).toEqual([
      ['todo', translated('project.statusTypes.todo')],
      ['in_progress', translated('project.statusTypes.inProgress')],
      ['done', translated('project.statusTypes.done')]
    ])
  })

  it('re-reads each label per access and falls back to English before boot', () => {
    const [todo] = statusTypeOptions
    expect(todo.label).toBe(translated('project.statusTypes.todo', 'en'))

    i18n.language = 'de'
    expect(todo.label).toBe(translated('project.statusTypes.todo', 'de'))

    i18n.booted = false
    expect(statusTypeOptions.map((option) => option.label)).toEqual([
      'To Do',
      'In Progress',
      'Done'
    ])
  })
})

describe('quick filter presets', () => {
  it('translates each preset label while keeping the filter payload untranslated', () => {
    expect(
      quickFilterPresets.map((preset) => ({
        id: preset.id,
        label: preset.label,
        icon: preset.icon,
        filters: preset.filters
      }))
    ).toEqual([
      {
        id: 'overdue',
        label: translated('filters.quickPresets.overdue'),
        icon: 'AlertTriangle',
        filters: { dueDate: { type: 'overdue', customStart: null, customEnd: null } }
      },
      {
        id: 'high-priority',
        label: translated('filters.quickPresets.highPriority'),
        icon: 'Flag',
        filters: { priorities: ['urgent', 'high'] }
      },
      {
        id: 'due-this-week',
        label: translated('filters.quickPresets.dueThisWeek'),
        icon: 'Calendar',
        filters: { dueDate: { type: 'this-week', customStart: null, customEnd: null } }
      },
      {
        id: 'repeating',
        label: translated('filters.quickPresets.repeating'),
        icon: 'Repeat',
        filters: { repeatType: 'repeating' }
      },
      {
        id: 'no-due-date',
        label: translated('filters.quickPresets.noDueDate'),
        icon: 'HelpCircle',
        filters: { dueDate: { type: 'none', customStart: null, customEnd: null } }
      }
    ])
  })

  it('re-reads preset labels per access and falls back to English before boot', () => {
    const [overdue] = quickFilterPresets
    expect(overdue.label).toBe(translated('filters.quickPresets.overdue', 'en'))

    i18n.language = 'fr'
    expect(overdue.label).toBe(translated('filters.quickPresets.overdue', 'fr'))

    i18n.booted = false
    expect(quickFilterPresets.map((preset) => preset.label)).toEqual([
      'Overdue',
      'High Priority',
      'Due This Week',
      'Repeating',
      'No Due Date'
    ])
  })
})

describe('validateProject', () => {
  it('accepts a project with a name, a todo status and a done status', () => {
    expect(validateProject('Roadmap', todoAndDone())).toEqual({})
    expect(i18n.calls).toEqual([])
  })

  it('reports a missing name and a name over 50 characters', () => {
    expect(validateProject('   ', todoAndDone()).name).toBe(
      translated('project.validation.nameRequired')
    )
    expect(validateProject('a'.repeat(50), todoAndDone()).name).toBeUndefined()
    expect(validateProject('a'.repeat(51), todoAndDone()).name).toBe(
      translated('project.validation.nameTooLong')
    )
  })

  it('requires at least two statuses', () => {
    expect(validateProject('Roadmap', [status()]).statuses).toBe(
      translated('project.validation.minStatuses')
    )
  })

  it('requires a todo status for new tasks and a done status for completed tasks', () => {
    const noTodo = [
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 0 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 1 })
    ]
    expect(validateProject('Roadmap', noTodo).statuses).toBe(
      translated('project.validation.needsTodoStatusForNewTasks')
    )

    const noDone = [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 1 })
    ]
    expect(validateProject('Roadmap', noDone).statuses).toBe(
      translated('project.validation.needsDoneStatusForCompletedTasks')
    )
  })

  it('rejects blank and case-insensitively duplicated status names', () => {
    const blankName = [...todoAndDone(), status({ id: 'wip', name: '  ', type: 'in_progress' })]
    expect(validateProject('Roadmap', blankName).statuses).toBe(
      translated('project.validation.statusNameRequired')
    )

    const duplicated = [
      ...todoAndDone(),
      status({ id: 'wip', name: ' done ', type: 'in_progress' })
    ]
    expect(validateProject('Roadmap', duplicated).statuses).toBe(
      translated('project.validation.statusNamesUnique')
    )
  })

  it('keeps the structural status error when a name problem is also present', () => {
    const noDoneAndBlank = [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'wip', name: '', type: 'in_progress', order: 1 })
    ]
    expect(validateProject('Roadmap', noDoneAndBlank).statuses).toBe(
      translated('project.validation.needsDoneStatusForCompletedTasks')
    )
  })

  it('falls back to English validation messages before i18n boots', () => {
    i18n.booted = false

    expect(validateProject('', [status()])).toEqual({
      name: 'Project name is required',
      statuses: 'Projects need at least 2 statuses'
    })
    expect(validateProject('a'.repeat(51), todoAndDone()).name).toBe(
      'Project name must be 50 characters or less'
    )
  })
})

describe('canDeleteStatus', () => {
  it('refuses to drop below two statuses', () => {
    expect(canDeleteStatus(todoAndDone(), 'todo')).toEqual({
      canDelete: false,
      reason: translated('project.validation.minStatuses')
    })
  })

  it('refuses an id that is not in the list', () => {
    const statuses = [
      ...todoAndDone(),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress' })
    ]
    expect(canDeleteStatus(statuses, 'missing')).toEqual({
      canDelete: false,
      reason: translated('project.validation.statusNotFound')
    })
  })

  it('keeps the last todo status and the last done status', () => {
    const statuses = [
      ...todoAndDone(),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress' })
    ]

    expect(canDeleteStatus(statuses, 'todo')).toEqual({
      canDelete: false,
      reason: translated('project.validation.needsTodoStatus')
    })
    expect(canDeleteStatus(statuses, 'done')).toEqual({
      canDelete: false,
      reason: translated('project.validation.needsDoneStatus')
    })
  })

  it('allows deleting a duplicate todo, a duplicate done and any other type', () => {
    const statuses = [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'todo-2', name: 'Backlog', type: 'todo', order: 1 }),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 2 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 3 }),
      status({ id: 'done-2', name: 'Shipped', type: 'done', order: 4 })
    ]

    expect(canDeleteStatus(statuses, 'todo-2')).toEqual({ canDelete: true })
    expect(canDeleteStatus(statuses, 'done-2')).toEqual({ canDelete: true })
    expect(canDeleteStatus(statuses, 'wip')).toEqual({ canDelete: true })
    expect(i18n.calls).toEqual([])
  })

  it('falls back to English reasons before i18n boots', () => {
    i18n.booted = false
    const statuses = [
      ...todoAndDone(),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress' })
    ]

    expect(canDeleteStatus(todoAndDone(), 'todo').reason).toBe('Projects need at least 2 statuses')
    expect(canDeleteStatus(statuses, 'missing').reason).toBe('Status not found')
    expect(canDeleteStatus(statuses, 'todo').reason).toBe(
      "Projects need at least one 'To Do' status"
    )
    expect(canDeleteStatus(statuses, 'done').reason).toBe(
      "Projects need at least one 'Done' status"
    )
  })
})

describe('project defaults', () => {
  it('gives every new project fresh status ids without mutating the shared defaults', () => {
    const first = createDefaultProject()
    const second = createDefaultProject()

    expect(first.statuses.map((s) => s.id)).not.toEqual(second.statuses.map((s) => s.id))
    expect(new Set(first.statuses.map((s) => s.id)).size).toBe(3)
    expect(first.statuses.map((s) => s.order)).toEqual([0, 1, 2])
    expect(defaultStatuses.map((s) => s.id)).toEqual(['todo', 'in-progress', 'done'])
  })

  it('keeps persisted status names in English even when the UI locale is not', () => {
    // These names are written to the data DB and synced; only the display-only
    // `statusTypeOptions` above are translated.
    i18n.language = 'de'

    expect(createDefaultProject().statuses.map((s) => s.name)).toEqual([
      'To Do',
      'In Progress',
      'Done'
    ])
    expect(i18n.calls).toEqual([])
  })

  it('creates a blank status at the requested order with a unique id', () => {
    const created = createDefaultStatus(4)

    expect(created).toMatchObject({ name: '', type: 'todo', color: '#6b7280', order: 4 })
    expect(created.id.startsWith('status-')).toBe(true)
    expect(createDefaultStatus(4).id).not.toBe(created.id)
    expect(generateId().startsWith('id-')).toBe(true)
    expect(generateId('project').startsWith('project-')).toBe(true)
  })
})

describe('translation keys', () => {
  it('only asks for keys that exist in the shipped English tasks bundle', () => {
    dueDateFilterOptions.forEach((option) => option.label)
    statusTypeOptions.forEach((option) => option.label)
    quickFilterPresets.forEach((preset) => preset.label)
    validateProject('', [status()])
    validateProject('a'.repeat(51), [
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 0 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 1 })
    ])
    validateProject('Roadmap', [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 1 })
    ])
    validateProject('Roadmap', [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 1 }),
      status({ id: 'blank', name: '', type: 'in_progress', order: 2 })
    ])
    validateProject('Roadmap', [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 1 }),
      status({ id: 'dup', name: 'done', type: 'in_progress', order: 2 })
    ])
    const statuses = [
      status({ id: 'todo', name: 'To Do', type: 'todo', order: 0 }),
      status({ id: 'wip', name: 'In Progress', type: 'in_progress', order: 1 }),
      status({ id: 'done', name: 'Done', type: 'done', order: 2 })
    ]
    canDeleteStatus(statuses.slice(0, 2), 'todo')
    canDeleteStatus(statuses, 'missing')
    canDeleteStatus(statuses, 'todo')
    canDeleteStatus(statuses, 'done')

    const requested = [...new Set(i18n.calls.map((call) => call.key))]
    expect(requested.length).toBeGreaterThanOrEqual(27)
    expect(requested.filter((key) => typeof lookup(key) !== 'string')).toEqual([])
  })
})
