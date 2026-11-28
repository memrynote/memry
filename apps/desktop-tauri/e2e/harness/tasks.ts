// Task and project writes over the `tasks_*` commands, the port of the Electron specs'
// `window.api.tasks.*` calls.
import type { Page } from './pw-compat/page'
import { invoke } from './vault-commands'

// `TaskMutation` and `ProjectMutation` of the generated bindings, reduced to what a spec reads.
interface Mutation {
  success: boolean
  error?: string | null
  task?: { id: string } | null
  project?: { id: string } | null
}

/** Makes a project with a Backlog and a Done status, as the Electron sync specs do. */
export async function createTaskProject(page: Page, name: string): Promise<string> {
  const result = await invoke<Mutation>(page, 'tasks_project_create', {
    input: {
      name,
      color: '#3b82f6',
      icon: 'FolderKanban',
      statuses: [
        { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
        { name: 'Done', color: '#10b981', type: 'done', order: 1 }
      ]
    }
  })
  if (!result.success || !result.project) throw new Error(result.error ?? 'project failed')
  return result.project.id
}

export async function createTask(page: Page, projectId: string, title: string): Promise<string> {
  const result = await invoke<Mutation>(page, 'tasks_create', {
    input: { projectId, title }
  })
  if (!result.success || !result.task) throw new Error(result.error ?? 'task failed')
  return result.task.id
}

export async function updateTaskTitle(page: Page, id: string, title: string): Promise<void> {
  const result = await invoke<Mutation>(page, 'tasks_update', { input: { id, title } })
  if (!result.success) throw new Error(result.error ?? 'task update failed')
}

export async function taskTitle(page: Page, id: string): Promise<string | null> {
  return (await invoke<{ title: string } | null>(page, 'tasks_get', { id }))?.title ?? null
}
