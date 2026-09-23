// @ts-nocheck - E2E test; window.api typing lives in the renderer bundle
/**
 * A template is a snapshot, so it must never carry a task's identity (#2331).
 *
 * A task lives in a note as `- [ ] Title {task:<id>}`. Before this fix the
 * template editor turned every checkbox into a real `tasks` row with no note
 * behind it, and a template body kept the `{task:<id>}` suffix. Every note made
 * from that template then pointed at the SAME task: ticking it in one note
 * ticked it everywhere, and deleting it anywhere left a "Task deleted" row in
 * every other note and in each note made from the template afterwards.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { SELECTORS } from './utils/electron-helpers'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { getNoteFileBodyById } from './utils/note-sync-helpers'

async function templateContent(page: Page, id: string): Promise<string> {
  return page.evaluate(async (templateId) => {
    const template = await window.api.templates.get(templateId)
    return template?.content ?? ''
  }, id)
}

async function taskIdsTitled(page: Page, title: string): Promise<string[]> {
  return page.evaluate(async (wanted) => {
    const res = await window.api.tasks.list({
      includeCompleted: true,
      includeArchived: true,
      limit: 500
    })
    return (res.tasks ?? []).filter((task) => task.title === wanted).map((task) => task.id)
  }, title)
}

async function openTemplateEditor(page: Page, name: string): Promise<void> {
  await page.evaluate(() => window.api.quickCapture.openSettings('templates'))
  await expect(page.getByRole('dialog')).toBeVisible({ timeout: 15_000 })

  const row = page.locator(`[role="button"][aria-label="${name}"]`)
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.click()

  await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 15_000 })
}

test.describe('Template task identity', () => {
  test('a checkbox edited in the template editor stays a template line, not a task', async ({
    page
  }) => {
    await ready(page)

    const templateName = uniqueLabel('Checklist Template')
    const taskTitle = uniqueLabel('Water the plants')
    const marker = 'edited-in-e2e'

    const templateId = await page.evaluate(
      async ({ name, content }) => {
        const created = await window.api.templates.create({ name, content })
        if (!created.success || !created.template) {
          throw new Error(created.error ?? 'template create failed')
        }
        return created.template.id
      },
      { name: templateName, content: `Intro line.\n\n- [ ] ${taskTitle}` }
    )

    await openTemplateEditor(page, templateName)

    const paragraph = page.locator(SELECTORS.noteEditor).getByText('Intro line.')
    await paragraph.click()
    await page.keyboard.press('End')
    await page.keyboard.type(` ${marker}`)

    await expect
      .poll(() => templateContent(page, templateId), { timeout: 30_000 })
      .toContain(marker)

    // The editor debounces checkbox conversion, so give it well past that
    // window before asserting nothing was minted.
    await page.waitForTimeout(3_000)

    expect(await taskIdsTitled(page, taskTitle), 'no task row minted by the template').toEqual([])
    const content = await templateContent(page, templateId)
    expect(content).toContain(`- [ ] ${taskTitle}`)
    expect(content).not.toContain('{task:')
  })

  test('a note made from a template that carries a task does not share that task', async ({
    page
  }) => {
    await ready(page)

    const templateName = uniqueLabel('Task Template')
    const taskTitle = uniqueLabel('Call the plumber')
    const noteTitle = uniqueLabel('From Template')

    const seeded = await page.evaluate(
      async ({ name, title, noteTitle }) => {
        const { projects } = await window.api.tasks.listProjects()
        const projectId = projects[0]?.id
        if (!projectId) throw new Error('no project to create the source task in')
        const task = await window.api.tasks.create({ projectId, title })
        if (!task.success || !task.task) throw new Error(task.error ?? 'task create failed')

        // What "Save as template" sends for a note that holds the task.
        const created = await window.api.templates.create({
          name,
          content: `- [ ] ${title} {task:${task.task.id}}`
        })
        if (!created.success || !created.template) {
          throw new Error(created.error ?? 'template create failed')
        }

        const note = await window.api.notes.create({ title: noteTitle, content: '' })
        if (!note.note?.id) throw new Error(note.error ?? 'note create failed')
        const applied = await window.api.notes.applyTemplate({
          noteId: note.note.id,
          templateId: created.template.id,
          mode: 'full'
        })
        if (!applied.success) throw new Error(applied.error ?? 'apply template failed')

        return { sourceTaskId: task.task.id, noteId: note.note.id }
      },
      { name: templateName, title: taskTitle, noteTitle }
    )

    const appliedBody = await getNoteFileBodyById(page, seeded.noteId)
    expect(appliedBody, 'the note does not inherit the template task id').not.toContain(
      `{task:${seeded.sourceTaskId}}`
    )
    expect(appliedBody).toContain(`- [ ] ${taskTitle}`)
  })
})
