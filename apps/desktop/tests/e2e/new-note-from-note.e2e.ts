import { test, expect } from './fixtures'
import { SELECTORS, tabSessionStorageKey } from './utils/electron-helpers'
import { ready } from './utils/desktop-test-helpers'

const FOLDER = 'Clients/A'
const SOURCE_TITLE = 'Project X'
const SOURCE_TAGS = ['client-a', '2026']
const SOURCE_PROPERTIES = { Status: 'Active', Priority: 'High', Owner: 'Kaan' }
const SOURCE_ICON = '📁'

test.describe('New note from this note (#2329)', () => {
  test('copies the icon, tags and properties into an empty note in the same folder', async ({
    page
  }) => {
    await ready(page)

    const sourceId = await page.evaluate(
      async ({ folder, title, tags, properties, icon }) => {
        const created = await window.api.notes.create({
          title,
          content: 'Kickoff body',
          folder,
          tags
        })
        const id = created.note?.id
        if (!id) throw new Error(created.error ?? 'source create failed')
        const iconed = await window.api.notes.update({ id, emoji: icon })
        if (!iconed.success) throw new Error(iconed.error ?? 'source icon failed')
        const propertied = await window.api.properties.set(id, properties)
        if (!propertied.success) throw new Error(propertied.error ?? 'source properties failed')
        return id
      },
      {
        folder: FOLDER,
        title: SOURCE_TITLE,
        tags: SOURCE_TAGS,
        properties: SOURCE_PROPERTIES,
        icon: SOURCE_ICON
      }
    )

    const storageKey = await tabSessionStorageKey(page)
    await page.addInitScript(
      ({ id, title, key }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            version: 2,
            tabGroups: {
              g1: {
                id: 'g1',
                activeTabId: 'note-tab',
                tabs: [
                  {
                    id: 'note-tab',
                    type: 'note',
                    title,
                    icon: 'file',
                    path: `/notes/${id}`,
                    entityId: id,
                    isPinned: false
                  }
                ]
              }
            },
            layout: { type: 'leaf', tabGroupId: 'g1' },
            activeGroupId: 'g1',
            settings: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
            savedAt: Date.now()
          })
        )
      },
      { id: sourceId, title: SOURCE_TITLE, key: storageKey }
    )
    await page.reload()
    await ready(page)
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(SOURCE_TITLE, {
      timeout: 20_000
    })

    await page.locator('[data-testid="note-more-menu"]').first().click()
    await page.getByRole('option', { name: 'New note from this note' }).click()

    await expect(
      page.getByText('Created with 2 tags and 3 properties from Project X').first()
    ).toBeVisible({ timeout: 10_000 })
    const nameField = page.getByRole('textbox', { name: 'Rename' })
    await expect(nameField, 'the caret lands in the new note name').toBeFocused({
      timeout: 10_000
    })
    await expect(nameField).toHaveValue('Untitled')
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue('Untitled')

    const readNote = (notePath: string) =>
      page.evaluate(async (p) => {
        const note = await window.api.notes.getByPath(p)
        return note
          ? {
              emoji: note.emoji ?? null,
              tags: note.tags,
              properties: note.properties,
              content: note.content.trim()
            }
          : null
      }, notePath)

    const expected = {
      emoji: SOURCE_ICON,
      tags: SOURCE_TAGS,
      properties: SOURCE_PROPERTIES,
      content: ''
    }
    await expect.poll(() => readNote(`${FOLDER}/Untitled.md`)).toEqual(expected)

    await nameField.press('Escape')
    await page.evaluate(async (id) => {
      const updated = await window.api.notes.update({ id, tags: ['changed-later'] })
      if (!updated.success) throw new Error(updated.error ?? 'source update failed')
    }, sourceId)
    expect(
      (await readNote(`${FOLDER}/Untitled.md`))?.tags,
      'a later edit to the source does not reach the copy'
    ).toEqual(SOURCE_TAGS)

    await page.locator(`[data-tree-node-id="${sourceId}"]`).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'New note from this note' }).click()

    await expect
      .poll(() => readNote(`${FOLDER}/Untitled 1.md`), {
        message: 'the sidebar entry point creates a second copy in the same folder'
      })
      .toEqual({ ...expected, tags: ['changed-later'] })
  })
})
