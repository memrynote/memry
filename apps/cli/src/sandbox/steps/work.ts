import { eventSpecs } from '../content/calendar.ts'
import { projects } from '../content/projects.ts'
import { taskSpecs } from '../content/tasks.ts'
import { canvasId, need, type SandboxContext, type SandboxStep } from '../context.ts'
import type { TaskSpec } from '../specs.ts'

/** UTC midnight of a calendar day: the CLI's all-day event shape (packages/app-core/src/calendar.ts). */
const utcMidnight = (date: string): string => `${date}T00:00:00.000Z`

export const createEvents: SandboxStep = async (ctx) => {
  for (const spec of eventSpecs(ctx.clock)) {
    const allDay = !spec.start
    const event = await ctx.app.calendar.events.create({
      title: spec.title,
      startAt: allDay ? utcMidnight(ctx.clock.date(spec.day)) : ctx.clock.at(spec.day, spec.start!),
      endAt: allDay
        ? utcMidnight(ctx.clock.date(spec.day + (spec.days ?? 1)))
        : ctx.clock.at(spec.day, spec.end ?? spec.start!),
      timezone: ctx.clock.timezone,
      isAllDay: allDay,
      location: spec.location,
      description: spec.description
    })
    ctx.events.set(spec.key, event.id)
  }
}

function sourceNoteId(ctx: SandboxContext, source: string | undefined): string | null {
  if (!source) return null
  if (source.startsWith('journal:')) {
    return need(ctx.journal, ctx.clock.date(Number(source.slice('journal:'.length))), 'journal day')
  }
  return need(ctx.notes, source, 'note').id
}

function repeatConfig(ctx: SandboxContext, spec: TaskSpec): Record<string, unknown> | null {
  if (!spec.repeat) return null
  // Full RepeatConfig shape from packages/contracts/src/tasks-api.ts; the CLI stores it as given.
  return {
    ...spec.repeat,
    ...(spec.repeat.dayOfMonth ? { monthlyType: 'dayOfMonth' } : {}),
    endType: 'never',
    completedCount: 0,
    createdAt: ctx.clock.ago(spec.created)
  }
}

export const createTasks: SandboxStep = async (ctx) => {
  for (const spec of taskSpecs(ctx.clock)) {
    const project = need(ctx.projects, spec.project ?? 'inbox', 'project')
    const done = spec.completed !== undefined
    // Completing a task sets only completedAt; the board column comes from statusId.
    const statusId = done
      ? project.doneStatusId
      : spec.status
        ? need(new Map(Object.entries(project.statuses)), spec.status, `status in ${project.name}`)
        : undefined
    const task = await ctx.app.tasks.create({
      title: spec.title,
      description: spec.description ?? null,
      projectId: project.id,
      statusId,
      parentId: spec.parent ? need(ctx.tasks, spec.parent, 'task').id : null,
      priority: spec.priority ?? 0,
      dueDate: spec.due !== undefined ? ctx.clock.date(spec.due) : null,
      dueTime: spec.dueTime ?? null,
      startDate: spec.start !== undefined ? ctx.clock.date(spec.start) : null,
      repeatConfig: repeatConfig(ctx, spec),
      repeatFrom: spec.repeat ? 'due' : null,
      sourceNoteId: sourceNoteId(ctx, spec.source),
      tags: spec.tags ?? [],
      linkedNoteIds: (spec.notes ?? []).map((key) => need(ctx.notes, key, 'note').id),
      linkedCanvasIds: (spec.canvases ?? []).map((key) => canvasId(ctx, key))
    })
    if (done) await ctx.app.tasks.complete(task.id)
    if (spec.archived) await ctx.app.tasks.archive(task.id)
    ctx.tasks.set(spec.key, { id: task.id, title: spec.title, done })
  }

  for (const spec of projects) {
    if (spec.archived)
      await ctx.app.tasks.projects.archive(need(ctx.projects, spec.key, 'project').id)
  }
}
