/**
 * TickTick import orchestration — pure, dependency-injected.
 *
 * Writes an ImportPlan through injected side-effecting deps so the ordering /
 * id-mapping / completion logic is unit-testable without electron, the DB, or
 * the reminders import graph.
 *
 * @module main/import/ticktick/apply-plan
 */

import type { ImportPlan, ImportWarning, RepeatConfig, StatusType } from '@memry/ticktick-import'
import type { TickTickImportSummary } from '@memry/contracts/ticktick-import-api'

interface CreateProjectArgs {
  name: string
  statuses: Array<{ name: string; color: string; type: StatusType; order: number }>
}

interface CreateTaskArgs {
  projectId: string
  title: string
  description: string | null
  priority: number
  statusId: string | null
  parentId: string | null
  position: number
  startDate: string | null
  dueDate: string | null
  dueTime: string | null
  repeatConfig: RepeatConfig | null
  repeatFrom: 'due' | 'completion' | null
  tags: string[]
}

interface StatusRow {
  id: string
  isDefault: boolean
  isDone: boolean
}

/** Side-effecting dependencies — injected so the orchestration stays testable. */
export interface ApplyDeps {
  createProject(
    a: CreateProjectArgs
  ): Promise<{ success: boolean; project?: { id: string } | null }>
  createTask(a: CreateTaskArgs): Promise<{ success: boolean; task?: { id: string } | null }>
  completeTask(a: { id: string; completedAt?: string }): Promise<unknown>
  archiveTask(id: string): Promise<unknown>
  getInboxProjectId(): string | undefined
  getStatusesByProject(projectId: string): StatusRow[]
  createReminder(a: { targetType: 'task'; targetId: string; remindAt: string }): void
}

/** Apply a parsed plan via injected deps. Sequential; per-row failures warn + continue. */
export async function applyPlan(plan: ImportPlan, deps: ApplyDeps): Promise<TickTickImportSummary> {
  const warnings: ImportWarning[] = [...plan.warnings]
  const projectIdByTemp = new Map<string, string>()
  const statusIdByTemp = new Map<string, string>()

  // Projects + statuses
  for (const p of plan.projects) {
    if (p.useExistingInbox) {
      const inboxId = deps.getInboxProjectId()
      if (!inboxId) {
        warnings.push({ message: 'No inbox project found; Inbox tasks skipped' })
        continue
      }
      projectIdByTemp.set(p.tempId, inboxId)
      const statuses = deps.getStatusesByProject(inboxId)
      const realTodo = statuses.find((s) => s.isDefault) ?? statuses[0]
      const realDone = statuses.find((s) => s.isDone) ?? realTodo
      const planTodo = p.statuses.find((s) => s.type !== 'done')
      const planDone = p.statuses.find((s) => s.isDone)
      if (planTodo && realTodo) statusIdByTemp.set(planTodo.tempId, realTodo.id)
      if (planDone && realDone) statusIdByTemp.set(planDone.tempId, realDone.id)
      continue
    }

    const result = await deps.createProject({
      name: p.name,
      statuses: p.statuses.map((s) => ({
        name: s.name,
        color: s.color,
        type: s.type,
        order: s.order
      }))
    })
    if (!result.success || !result.project) {
      warnings.push({ message: `Failed to create project "${p.name}"` })
      continue
    }
    projectIdByTemp.set(p.tempId, result.project.id)
    const realStatuses = deps.getStatusesByProject(result.project.id)
    p.statuses.forEach((planStatus, idx) => {
      const real = realStatuses[idx]
      if (real) statusIdByTemp.set(planStatus.tempId, real.id)
    })
  }

  // Tasks — parents before children so parentId resolves.
  const tempIdToRealId = new Map<string, string>()
  const ordered = [...plan.tasks].sort(
    (a, b) => (a.parentTempId ? 1 : 0) - (b.parentTempId ? 1 : 0)
  )
  const nowMs = Date.now()

  for (const t of ordered) {
    const projectId = projectIdByTemp.get(t.projectTempId)
    if (!projectId) {
      warnings.push({ message: `Task "${t.title}" skipped (no project)` })
      continue
    }
    try {
      const created = await deps.createTask({
        projectId,
        title: t.title,
        description: t.description,
        priority: t.priority,
        statusId: t.statusTempId ? (statusIdByTemp.get(t.statusTempId) ?? null) : null,
        parentId: t.parentTempId ? (tempIdToRealId.get(t.parentTempId) ?? null) : null,
        position: t.position,
        startDate: t.startDate,
        dueDate: t.dueDate,
        dueTime: t.dueTime,
        repeatConfig: t.repeatConfig,
        repeatFrom: t.repeatFrom,
        tags: t.tags
      })
      if (!created.success || !created.task) {
        warnings.push({ message: `Task "${t.title}" failed to import` })
        continue
      }
      const realId = created.task.id
      tempIdToRealId.set(t.tempId, realId)

      if (t.completedAt) await deps.completeTask({ id: realId, completedAt: t.completedAt })
      if (t.archivedAt) await deps.archiveTask(realId)

      for (const reminder of t.reminders) {
        // createReminder rejects past times (backups are usually old) — skip + warn.
        if (new Date(reminder.remindAt).getTime() <= nowMs) {
          warnings.push({ message: `Reminder for "${t.title}" is in the past; skipped` })
          continue
        }
        try {
          deps.createReminder({ targetType: 'task', targetId: realId, remindAt: reminder.remindAt })
        } catch (err) {
          warnings.push({ message: `Reminder for "${t.title}" failed: ${(err as Error).message}` })
        }
      }
    } catch (err) {
      warnings.push({ message: `Task "${t.title}" failed: ${(err as Error).message}` })
    }
  }

  return { canceled: false, stats: plan.stats, warnings }
}
