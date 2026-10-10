import { projects } from '../content/projects.ts'
import type { SandboxStep } from '../context.ts'

const options = (values: Array<[string, string]>): string =>
  JSON.stringify(values.map(([value, color]) => ({ value, color })))

/**
 * Vault-wide property definitions that are not tag fields (tag fields come from
 * steps/tags.ts). Never `relation`: desktop types relations from their
 * `memry://` values, and one unknown type in `.memry/properties.md` makes
 * desktop drop every definition.
 */
const definitions = [
  {
    name: 'topics',
    type: 'multiselect',
    options: options([
      ['Spaceflight', 'cobalt'],
      ['History', 'sand'],
      ['Note-taking', 'violet'],
      ['Design', 'teal'],
      ['Writing', 'rose']
    ])
  },
  {
    name: 'stage',
    type: 'status',
    options: JSON.stringify({
      categories: {
        todo: { label: 'To-do', options: [{ value: 'Draft', color: 'stone', default: true }] },
        in_progress: { label: 'In progress', options: [{ value: 'In review', color: 'amber' }] },
        done: { label: 'Complete', options: [{ value: 'Approved', color: 'emerald' }] }
      }
    })
  },
  { name: 'deadline', type: 'date', options: JSON.stringify({ showOnCalendar: true }) },
  { name: 'project', type: 'project', options: null },
  { name: 'mood', type: 'number', options: null },
  { name: 'energy', type: 'number', options: null },
  { name: 'sleep', type: 'number', options: null },
  { name: 'owned', type: 'checkbox', options: null },
  { name: 'tried', type: 'checkbox', options: null },
  { name: 'workout', type: 'checkbox', options: null },
  { name: 'url', type: 'url', options: null },
  { name: 'source', type: 'url', options: null },
  { name: 'summary', type: 'text', options: null },
  {
    name: 'level',
    type: 'select',
    options: options([
      ['Beginner', 'sage'],
      ['Intermediate', 'amber'],
      ['Advanced', 'coral']
    ])
  }
]

export const setup: SandboxStep = async ({ app, projects: projectRefs }) => {
  await app.settings.setGroup('general', { onboardingCompleted: true })
  await app.settings.setGroup('journal', { showStatsFooter: true })

  for (const definition of definitions) await app.properties.createDefinition(definition)

  for (const spec of projects) {
    const project = await app.tasks.projects.create({
      name: spec.name,
      description: spec.description,
      color: spec.color,
      icon: spec.icon
    })
    // New projects start with To Do / In Progress / Done (packages/app-core/src/tasks.ts).
    // Custom boards rename the first two, add the middle columns, and keep Done last.
    if (spec.statuses) {
      const [first, second, ...rest] = await app.tasks.projects.statuses(project.id)
      const names = spec.statuses
      await app.tasks.projects.updateStatus(first.id, { name: names[0], color: '#94a3b8' })
      await app.tasks.projects.updateStatus(second.id, { name: names[1], color: '#8b5cf6' })
      const done = rest.find((status) => status.isDone)
      if (!done) throw new Error('New project has no done status')
      const middle = []
      for (const [index, name] of names.slice(2, -1).entries()) {
        middle.push(
          await app.tasks.projects.createStatus(project.id, {
            name,
            color: ['#0ea5e9', '#f59e0b', '#ec4899'][index % 3]
          })
        )
      }
      await app.tasks.projects.updateStatus(done.id, { name: names[names.length - 1] })
      const order = [first.id, second.id, ...middle.map((status) => status.id), done.id]
      await app.tasks.projects.reorderStatuses(
        order,
        order.map((_, position) => position)
      )
    }

    const statuses = await app.tasks.projects.statuses(project.id)
    const doneStatus = statuses.find((status) => status.isDone)
    if (!doneStatus) throw new Error(`Project ${spec.name} has no done status`)
    projectRefs.set(spec.key, {
      id: project.id,
      name: spec.name,
      statuses: Object.fromEntries(statuses.map((status) => [status.name, status.id])),
      doneStatusId: doneStatus.id
    })
  }

  // The built-in Inbox project (apps/cli/src/app-core/database.ts ensureDefaultTaskProject).
  const inbox = await app.tasks.projects.get('inbox')
  if (!inbox) throw new Error('Inbox project missing')
  projectRefs.set('inbox', {
    id: inbox.id,
    name: inbox.name,
    statuses: { 'To Do': 'inbox-todo', 'In Progress': 'inbox-in-progress', Done: 'inbox-done' },
    doneStatusId: 'inbox-done'
  })
}
