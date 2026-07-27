import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'

/**
 * The three promises the hub redesign makes:
 *  - "View all" focuses a category without opening another app tab
 *  - the rail closes and reopens from the same control
 *  - a linked event leaves for the Calendar
 *
 * The exact calendar viewState (focusDate + focusCalendarEventId) is asserted in
 * the `open-linked-item` unit test; here we only check the navigation happens.
 */
test.describe('Project hub E2E', () => {
  test('switches tabs in place, toggles the rail, and opens a linked event in the calendar', async ({
    page
  }) => {
    await ready(page)

    const projectName = uniqueLabel('Hub Project')
    const taskTitle = uniqueLabel('Hub Task')
    const noteTitle = uniqueLabel('Hub Note')
    const eventTitle = uniqueLabel('Hub Event')

    const seeded = await page.evaluate(
      async ({ projectName, taskTitle, noteTitle, eventTitle }) => {
        const api = window.api

        const projectResult = await api.tasks.createProject({
          name: projectName,
          description: 'Project hub E2E',
          color: '#6366f1',
          icon: 'FolderKanban',
          statuses: [
            { name: 'To Do', color: '#6b7280', type: 'todo', order: 0 },
            { name: 'Done', color: '#10b981', type: 'done', order: 1 }
          ]
        })
        if (!projectResult.success || !projectResult.project) {
          throw new Error(projectResult.error ?? 'project create failed')
        }
        const projectId = projectResult.project.id

        const statuses = await api.tasks.listStatuses(projectId)
        const todo = statuses.find((status) => status.name === 'To Do')
        if (!todo) throw new Error('todo status missing')

        const task = await api.tasks.create({ projectId, statusId: todo.id, title: taskTitle })
        if (!task.success) throw new Error('task create failed')

        const note = await api.notes.create({ title: noteTitle })
        if (!note.success || !note.note) throw new Error('note create failed')
        await api.tasks.linkProjectItem({ projectId, itemType: 'note', itemId: note.note.id })

        const event = await api.calendar.createEvent({
          title: eventTitle,
          startAt: '2026-08-08T12:00:00.000Z',
          endAt: '2026-08-08T13:00:00.000Z',
          isAllDay: false
        })
        const eventId = 'event' in event ? event.event?.id : undefined
        if (!eventId) throw new Error('event create failed')
        await api.tasks.linkProjectItem({
          projectId,
          itemType: 'calendar_event',
          itemId: eventId
        })

        return { projectId }
      },
      { projectName, taskTitle, noteTitle, eventTitle }
    )

    expect(seeded.projectId).toBeTruthy()

    // Open the project from the sidebar, the way a user reaches its hub.
    await page.getByRole('button', { name: projectName }).first().click()
    await expect(page.getByRole('tab', { name: /overview/i })).toHaveAttribute(
      'aria-selected',
      'true'
    )

    const appTabsBefore = await page.locator('[role="tab"]').count()

    // "View all" on the Tasks section focuses that tab in place.
    await page
      .getByRole('button', { name: /view all/i })
      .first()
      .click()
    await expect(page.getByRole('tab', { name: /tasks/i })).toHaveAttribute('aria-selected', 'true')
    expect(await page.locator('[role="tab"]').count()).toBe(appTabsBefore)

    // The rail toggle stays in place while the rail is closed.
    const railToggle = page.getByRole('button', { name: /toggle project details/i })
    await expect(page.getByTestId('project-rail')).toBeVisible()
    await railToggle.click()
    await expect(page.getByTestId('project-rail')).toHaveCount(0)
    await expect(railToggle).toBeVisible()
    await railToggle.click()
    await expect(page.getByTestId('project-rail')).toBeVisible()

    // A linked event leaves the hub for the Calendar.
    await page.getByRole('tab', { name: /events/i }).click()
    await page.getByRole('button', { name: new RegExp(`open event ${eventTitle}`, 'i') }).click()
    await expect(page.getByRole('heading', { name: /calendar/i }).first()).toBeVisible()
  })
})
