// @ts-nocheck - E2E tests in development, follow notes.e2e.ts convention
/**
 * A task block in a note opens the task detail drawer in place: the note tab
 * stays active, edits in the drawer reach the block live, Esc closes it, and
 * the drawer's Open in Tasks button still reaches the Tasks page.
 */

import { test, expect } from './fixtures'
import { waitForAppReady, waitForVaultReady, createNote } from './utils/electron-helpers'

const EDITOR_SELECTOR = '[aria-label="Rich text editor"] [contenteditable="true"]'
const TASK_BLOCK_SELECTOR = '[data-content-type="taskBlock"]'
const DRAWER_SELECTOR = 'aside[aria-label="Task details"][data-state="open"]'

async function createTaskInDb(page, title: string): Promise<string> {
  return (await page.evaluate(
    async ({ title }) => {
      const api = (window as any).api
      const projects = (await api.tasks.listProjects())?.projects ?? []
      const project = projects.find((p: any) => p.isDefault || p.isInbox) ?? projects[0]
      const created = await api.tasks.create({ projectId: project.id, title, priority: 0 })
      if (!created?.success) throw new Error('tasks.create failed: ' + JSON.stringify(created))
      return created.task.id as string
    },
    { title }
  )) as string
}

async function listSubtaskTitles(page, parentId: string): Promise<string[]> {
  return (await page.evaluate(
    async ({ parentId }) => {
      const res = await (window as any).api.tasks.list({ includeCompleted: true })
      return (res?.tasks ?? []).filter((t: any) => t.parentId === parentId).map((t: any) => t.title)
    },
    { parentId }
  )) as string[]
}

test.describe('Note task block detail drawer', () => {
  test.beforeEach(async ({ page }) => {
    await waitForAppReady(page)
    await waitForVaultReady(page)
  })

  test('opens in place, edits live, closes on Esc, and still reaches Tasks', async ({ page }) => {
    const title = `Drawer task ${Date.now()}`
    await createNote(page, `Drawer Note ${Date.now()}`)
    const taskId = await createTaskInDb(page, title)
    await page.locator(EDITOR_SELECTOR).first().waitFor({ state: 'visible', timeout: 8000 })
    await page.evaluate(
      ({ taskId, title }) => {
        const editor = (window as any).__memryEditor
        editor.replaceBlocks(editor.document, [
          { type: 'taskBlock', props: { taskId, title, checked: false, parentTaskId: '' } },
          { type: 'paragraph', content: [{ type: 'text', text: 'after', styles: {} }] }
        ])
      },
      { taskId, title }
    )

    const block = page.locator(TASK_BLOCK_SELECTOR).first()
    // A freshly inserted block opens in title edit; the arrow is live either way.
    await expect(block.getByTitle('Open in task panel')).toBeAttached({ timeout: 8000 })

    await block.hover()
    await block.getByTitle('Open in task panel').click()

    const drawer = page.locator(DRAWER_SELECTOR)
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('textbox', { name: 'Task name' })).toHaveValue(title)
    await expect(page.locator(EDITOR_SELECTOR).first()).toBeVisible()

    const renamed = `${title} renamed`
    await drawer.getByRole('textbox', { name: 'Task name' }).fill(renamed)
    await expect(block.locator('[data-task-title-trigger]')).toHaveText(renamed, { timeout: 8000 })

    await drawer.getByRole('button', { name: 'Add sub-issue' }).click()
    const subIssueInput = drawer.getByRole('textbox', { name: 'Add sub-issue…' })
    await subIssueInput.fill('Drawer subtask')
    await subIssueInput.press('Enter')
    await expect
      .poll(() => listSubtaskTitles(page, taskId), { timeout: 8000 })
      .toContain('Drawer subtask')
    await expect(drawer.getByText('Drawer subtask')).toBeVisible()

    // The first Esc leaves the sub-issue input, the next one closes the drawer.
    await page.keyboard.press('Escape')
    if ((await drawer.count()) > 0) await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)

    await block.hover()
    await block.getByTitle('Open in task panel').click()
    await expect(drawer).toBeVisible()
    await drawer.getByRole('button', { name: 'Open in Tasks' }).click()
    await expect(page.locator(DRAWER_SELECTOR)).toBeVisible()
    await expect(
      page.locator(DRAWER_SELECTOR).getByRole('textbox', { name: 'Task name' })
    ).toHaveValue(renamed)
  })
})
