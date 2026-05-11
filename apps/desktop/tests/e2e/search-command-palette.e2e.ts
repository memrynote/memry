import { test, expect } from './fixtures'
import { MOD, ready, uniqueLabel } from './utils/desktop-test-helpers'

test.describe('Search and command palette E2E', () => {
  test('queries indexed content, recent reasons, and command-palette type filters', async ({
    page
  }) => {
    await ready(page)

    const tag = 'e2e-search-command'
    const noteTitle = uniqueLabel('Search Note')
    const taskTitle = uniqueLabel('Search Task')
    const inboxTitle = uniqueLabel('Search Inbox')

    const seeded = await page.evaluate(
      async ({ noteTitle, taskTitle, inboxTitle, tag }) => {
        const api = window.api
        const note = await api.notes.create({
          title: noteTitle,
          content: 'Note body for search coverage.',
          tags: [tag]
        })
        if (!note.success || !note.note) throw new Error(note.error ?? 'failed to seed note')

        const projects = await api.tasks.listProjects()
        const projectId = projects.projects[0]?.id
        if (!projectId) throw new Error('default task project missing')
        const task = await api.tasks.create({
          projectId,
          title: taskTitle,
          priority: 3,
          tags: [tag]
        })
        if (!task.success || !task.task) throw new Error(task.error ?? 'failed to seed task')

        const inbox = await api.inbox.captureText({
          title: inboxTitle,
          content: 'Inbox item for search coverage.',
          tags: [tag],
          force: true,
          source: 'api'
        })
        if (!inbox.success || !inbox.item) throw new Error(inbox.error ?? 'failed to seed inbox')

        await api.search.rebuildIndex().catch(() => null)
        await api.search.addReason({
          itemId: note.note.id,
          itemType: 'note',
          itemTitle: note.note.title,
          searchQuery: 'search note'
        })

        return {
          noteId: note.note.id,
          noteTitle: note.note.title,
          taskTitle: task.task.title,
          inboxTitle: inbox.item.title
        }
      },
      { noteTitle, taskTitle, inboxTitle, tag }
    )

    await expect
      .poll(
        () =>
          page.evaluate(
            async ({ title, tag }) => {
              const results = await window.api.search.query({
                text: title,
                types: ['note'],
                tags: [tag],
                limit: 10
              })
              return results.groups.flatMap((group) => group.results).map((item) => item.title)
            },
            { title: seeded.noteTitle, tag }
          ),
        { timeout: 20_000 }
      )
      .toContain(seeded.noteTitle)

    await expect
      .poll(
        () =>
          page.evaluate(async (title) => {
            const results = await window.api.search.query({
              text: title,
              types: ['task'],
              limit: 10
            })
            return results.groups.flatMap((group) => group.results).map((item) => item.title)
          }, seeded.taskTitle),
        { timeout: 20_000 }
      )
      .toContain(seeded.taskTitle)

    await expect
      .poll(
        () =>
          page.evaluate(async (title) => {
            const results = await window.api.search.query({
              text: title,
              types: ['inbox'],
              limit: 10
            })
            return results.groups.flatMap((group) => group.results).map((item) => item.title)
          }, seeded.inboxTitle),
        { timeout: 20_000 }
      )
      .toContain(seeded.inboxTitle)

    const reasons = await page.evaluate(() => window.api.search.getReasons())
    expect(reasons.map((reason) => reason.itemId)).toContain(seeded.noteId)

    await page.keyboard.press(`${MOD}+k`)
    const searchInput = page.locator('[cmdk-input], input[placeholder*="Search"]').first()
    await expect(searchInput).toBeVisible()
    await searchInput.fill(seeded.noteTitle)

    const commandDialog = page.locator('[role="dialog"]').filter({ has: searchInput }).first()
    await expect(commandDialog.getByText(seeded.noteTitle, { exact: true }).first()).toBeVisible()
    await commandDialog.locator('button').filter({ hasText: 'Tasks' }).first().click()
    await expect(commandDialog.getByText(seeded.noteTitle, { exact: true }).first()).toBeHidden()
    await searchInput.fill(seeded.taskTitle)
    await expect(commandDialog.getByText(seeded.taskTitle, { exact: true }).first()).toBeVisible()
  })
})
