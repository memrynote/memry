import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { navigateTo, showAllTasksScope } from './utils/electron-helpers'

test.describe('Tasks and Kanban E2E', () => {
  test('covers custom statuses, task moves, bulk actions, saved filters, and Kanban rendering', async ({
    page
  }) => {
    await ready(page)

    const projectName = uniqueLabel('Project')
    const activeTaskTitle = uniqueLabel('Kanban Task')
    const movedTaskTitle = uniqueLabel('Moved Task')
    const completedTaskTitle = uniqueLabel('Completed Task')
    const filterName = uniqueLabel('Saved Filter')

    const result = await page.evaluate(
      async ({ projectName, activeTaskTitle, movedTaskTitle, completedTaskTitle, filterName }) => {
        const api = window.api
        const projectResult = await api.tasks.createProject({
          name: projectName,
          description: 'Advanced E2E project',
          color: '#3b82f6',
          icon: 'FolderKanban',
          statuses: [
            { name: 'Backlog', color: '#6b7280', type: 'todo', order: 0 },
            { name: 'Doing', color: '#f59e0b', type: 'in_progress', order: 1 },
            { name: 'Done', color: '#10b981', type: 'done', order: 2 }
          ]
        })
        if (!projectResult.success || !projectResult.project) {
          throw new Error(projectResult.error ?? 'project create failed')
        }

        const projectId = projectResult.project.id
        const statuses = await api.tasks.listStatuses(projectId)
        const backlog = statuses.find((status) => status.name === 'Backlog')
        const doing = statuses.find((status) => status.name === 'Doing')
        if (!backlog || !doing) throw new Error('project statuses missing')

        const activeTask = await api.tasks.create({
          projectId,
          statusId: backlog.id,
          title: activeTaskTitle,
          priority: 4,
          tags: ['e2e-tasks']
        })
        const movedTask = await api.tasks.create({
          projectId,
          statusId: backlog.id,
          title: movedTaskTitle,
          priority: 3,
          tags: ['e2e-tasks']
        })
        const completedTask = await api.tasks.create({
          projectId,
          statusId: backlog.id,
          title: completedTaskTitle,
          priority: 2,
          tags: ['e2e-tasks']
        })
        if (!activeTask.success || !activeTask.task || !movedTask.success || !movedTask.task) {
          throw new Error('task create failed')
        }
        if (!completedTask.success || !completedTask.task) throw new Error('task create failed')

        await api.tasks.move({
          taskId: movedTask.task.id,
          targetProjectId: projectId,
          targetStatusId: doing.id,
          targetParentId: null,
          position: 1
        })
        const moved = await api.tasks.get(movedTask.task.id)
        const bulkComplete = await api.tasks.bulkComplete([
          movedTask.task.id,
          completedTask.task.id
        ])
        const bulkArchive = await api.tasks.bulkArchive([completedTask.task.id])
        const taskList = await api.tasks.list({
          projectId,
          includeCompleted: true,
          includeArchived: true,
          search: 'E2E',
          limit: 20
        })

        const savedFilter = await api.savedFilters.create({
          name: filterName,
          config: {
            filters: {
              search: 'E2E',
              projectIds: [projectId],
              priorities: ['urgent'],
              dueDate: { type: 'any', customStart: null, customEnd: null },
              statusIds: [doing.id],
              completion: 'all',
              repeatType: 'all',
              hasTime: 'all'
            },
            sort: { field: 'priority', direction: 'desc' },
            starred: true
          }
        })
        if (!savedFilter.success || !savedFilter.savedFilter) {
          throw new Error(savedFilter.error ?? 'saved filter create failed')
        }
        const updatedFilter = await api.savedFilters.update({
          id: savedFilter.savedFilter.id,
          name: `${filterName} Updated`
        })
        const filtersAfterUpdate = await api.savedFilters.list()
        await api.savedFilters.delete(savedFilter.savedFilter.id)
        const filtersAfterDelete = await api.savedFilters.list()

        return {
          projectId,
          doingId: doing.id,
          activeTaskId: activeTask.task.id,
          activeTaskTitle: activeTask.task.title,
          movedStatusId: moved?.statusId,
          bulkComplete,
          bulkArchive,
          taskList,
          updatedFilter,
          filtersAfterUpdate,
          filtersAfterDelete
        }
      },
      { projectName, activeTaskTitle, movedTaskTitle, completedTaskTitle, filterName }
    )

    expect(result.movedStatusId).toBe(result.doingId)
    expect(result.bulkComplete).toMatchObject({ success: true, count: 2 })
    expect(result.bulkArchive).toMatchObject({ success: true, count: 1 })
    expect(result.taskList.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([result.activeTaskId])
    )
    expect(result.updatedFilter.savedFilter).toMatchObject({ name: `${filterName} Updated` })
    expect(result.filtersAfterUpdate.savedFilters.map((filter) => filter.name)).toContain(
      `${filterName} Updated`
    )
    expect(result.filtersAfterDelete.savedFilters.map((filter) => filter.name)).not.toContain(
      `${filterName} Updated`
    )

    await navigateTo(page, 'tasks')
    await showAllTasksScope(page)
    await page.getByRole('radio', { name: 'Kanban view' }).click()
    await expect(page.getByLabel('Kanban board')).toBeVisible()
    await expect(page.getByRole('button', { name: result.activeTaskTitle })).toBeVisible()
  })
})
