import { createId } from '@memry/app-core/ids'
import { OFFLINE_CLOCK_DEVICE_ID } from '@memry/contracts/sync-api'

import { taskSpecs } from '../content/tasks.ts'
import type { PostContext } from './index.ts'

/**
 * Task history. Every CLI task op stamps "now" (packages/app-core/src/tasks.ts),
 * so a fresh vault would claim every task was created and finished today.
 * created_at and completed_at are plain row timestamps, not per-field clocks.
 */
export function backdateTasks({ ctx, data }: PostContext): void {
  const update = data.prepare(
    'UPDATE tasks SET created_at = ?, modified_at = ?, completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE ? END WHERE id = ?'
  )
  for (const spec of taskSpecs(ctx.clock)) {
    const id = ctx.tasks.get(spec.key)!.id
    const created = ctx.clock.ago(spec.created, '10:15')
    const completed = spec.completed !== undefined ? ctx.clock.ago(spec.completed, '17:05') : null
    const latest = new Date(
      Math.min(ctx.clock.now.getTime(), new Date(completed ?? created).getTime())
    )
    update.run(created, latest.toISOString(), completed, id)
  }
}

/**
 * A few activity-log entries, so a finished task shows its story. Desktop's
 * writer is apps/desktop/src/main/tasks/activity-log.ts, which needs the
 * Electron main runtime; these rows use its shape (JSON-encoded values, actor
 * `user`, the offline device id) with clock NULL, which the first sync clocks
 * (initial-seed.ts seedUnclocked). All within the 90-day retention window.
 */
export function taskActivity({ ctx, data }: PostContext): void {
  const insert = data.prepare(
    `INSERT INTO task_activity (id, task_id, action, field, old_value, new_value, actor, device_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'user', ?, ?)`
  )
  const aurora = ctx.projects.get('aurora')!
  const statusOf = (name: string): string => aurora.statuses[name]
  const json = (value: unknown): string | null => (value === null ? null : JSON.stringify(value))
  const row = (
    taskKey: string,
    daysAgo: number,
    action: string,
    field: string | null,
    oldValue: unknown,
    newValue: unknown
  ): void => {
    insert.run(
      createId('activity'),
      ctx.tasks.get(taskKey)!.id,
      action,
      field,
      json(oldValue),
      json(newValue),
      OFFLINE_CLOCK_DEVICE_ID,
      ctx.clock.ago(daysAgo, '11:30')
    )
  }

  for (const spec of taskSpecs(ctx.clock).filter(
    (task) => task.project === 'aurora' && task.completed !== undefined
  )) {
    row(spec.key, spec.created, 'created', null, null, spec.title)
    row(
      spec.key,
      Math.round((spec.created + spec.completed!) / 2),
      'moved',
      'statusId',
      statusOf('Backlog'),
      statusOf('Design')
    )
    row(
      spec.key,
      spec.completed!,
      'completed',
      'completedAt',
      null,
      ctx.clock.ago(spec.completed!, '17:05')
    )
  }
  row('a-reading-view', 12, 'created', null, null, 'Finalize reading view typography')
  row('a-reading-view', 6, 'updated', 'priority', 2, 3)
  row('a-reading-view', 4, 'moved', 'statusId', statusOf('Backlog'), statusOf('Design'))
  row('a-offline', 3, 'updated', 'dueDate', ctx.clock.date(-5), ctx.clock.date(-2))
}

/**
 * Project hub extras the CLI has no input for. `home_note_id` is a plain
 * column (projects.update lacks it). File and event links are `project_links`
 * rows with item_type file / calendar_event, which desktop's
 * `tasks:project-link-item` writes; note links are left to the note-project
 * projector, which derives them from the `project:` frontmatter.
 */
export function projectExtras({ ctx, data }: PostContext): void {
  const aurora = ctx.projects.get('aurora')!
  data
    .prepare('UPDATE projects SET home_note_id = ? WHERE id = ?')
    .run(ctx.notes.get('aurora-brief')!.id, aurora.id)

  const link = data.prepare(
    'INSERT INTO project_links (id, project_id, item_type, item_id, position, pinned) VALUES (?, ?, ?, ?, ?, ?)'
  )
  link.run(createId('plink'), aurora.id, 'file', ctx.files.get('gestures-pdf')!.id, 0, 1)
  link.run(createId('plink'), aurora.id, 'calendar_event', ctx.events.get('design-review')!, 1, 1)
  link.run(createId('plink'), aurora.id, 'calendar_event', ctx.events.get('launch-day')!, 2, 0)
  link.run(createId('plink'), aurora.id, 'calendar_event', ctx.events.get('beta-retro')!, 3, 0)
}
