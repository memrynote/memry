import { test, expect } from './fixtures'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { createNote } from './utils/electron-helpers'

/**
 * Issue #2328: the note page menu only offered the body-only insert, so a
 * template's icon, tags and project never reached a note applied from there.
 */

const TEMPLATE_ICON = '🚀'
const TEMPLATE_TAG = 'e2e-apply-from-note-menu'

test.describe('Apply template from the note page menu', () => {
  test('sets the template icon, tag and project on the open note', async ({ page }) => {
    await ready(page)

    const projectName = uniqueLabel('Apply Template Project')
    const templateName = uniqueLabel('Apply From Menu')

    const projectId = await page.evaluate(
      async ({ projectName, templateName, icon, tag }) => {
        const project = await window.api.tasks.createProject({
          name: projectName,
          color: '#6366f1'
        })
        if (!project.success || !project.project) {
          throw new Error(project.error ?? 'project create failed')
        }
        const template = await window.api.templates.create({
          name: templateName,
          icon,
          tags: [tag],
          properties: [{ name: 'project', type: 'project', value: [projectName] }],
          content: '## From the template'
        })
        if (!template.success) throw new Error(template.error ?? 'template create failed')
        return project.project.id
      },
      { projectName, templateName, icon: TEMPLATE_ICON, tag: TEMPLATE_TAG }
    )

    const noteTitle = uniqueLabel('Apply Template Target')
    await createNote(page, noteTitle, 'Existing body')

    await page.locator('[data-testid="note-more-menu"]').first().click()
    await expect(
      page.getByRole('option', { name: 'Insert template content…' }),
      'the body-only insert says it inserts content only'
    ).toBeVisible()
    await page.getByRole('option', { name: 'Apply Template' }).click()

    await page.getByPlaceholder('Search templates...').fill(templateName)
    await page
      .getByRole('button', { name: new RegExp(templateName) })
      .first()
      .click()
    await page.getByRole('button', { name: 'Apply Template' }).click()
    await page.getByRole('button', { name: 'Replace content & add template details' }).click()
    await expect(page.getByText('Template applied').first()).toBeVisible({ timeout: 10_000 })

    await expect(
      page.getByTestId('note-title-icon').first(),
      'the open note shows the template icon'
    ).toContainText(TEMPLATE_ICON)
    await expect(
      page.getByRole('list', { name: 'Tags' }).getByRole('option', { name: TEMPLATE_TAG }),
      'the open note shows the template tag'
    ).toBeVisible()

    const noteId = await page.evaluate(async (title) => {
      const { notes } = await window.api.notes.list({})
      return notes.find((note) => note.title === title)?.id ?? null
    }, noteTitle)
    if (!noteId) throw new Error(`no note titled "${noteTitle}"`)

    const applied = await page.evaluate(async (id) => {
      const note = await window.api.notes.get(id)
      return { emoji: note?.emoji ?? null, tags: note?.tags ?? [], properties: note?.properties }
    }, noteId)

    expect(applied.emoji).toBe(TEMPLATE_ICON)
    expect(applied.tags).toContain(TEMPLATE_TAG)
    expect(applied.properties?.project).toEqual([projectName])

    await expect
      .poll(
        () =>
          page.evaluate(async (id) => {
            const links = await window.api.tasks.listProjectLinks(id)
            return Array.isArray(links) ? links.map((link) => link.itemId) : []
          }, projectId),
        { message: 'the project hub lists the note', timeout: 10_000 }
      )
      .toContain(noteId)
  })
})
