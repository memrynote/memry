import { test, expect } from './fixtures'
import { SELECTORS, seedNote, tabSessionStorageKey } from './utils/electron-helpers'
import { ready, uniqueLabel } from './utils/desktop-test-helpers'
import { normalizeBodyText } from './utils/note-sync-helpers'

const NOTE_BODY = '# Retro agenda\n\nWhat went well, what to change, owners for next week.'
const NOTE_TAG = 'e2e-save-as-template'
const PROPERTY_NAME = 'Stage'
const PROPERTY_VALUE = 'Draft'

test.describe('Save note as template', () => {
  let templateNames: string[] = []

  test.afterEach(async ({ page }) => {
    const names = templateNames
    templateNames = []
    if (names.length === 0) return
    await page
      .evaluate(async (targets) => {
        const { templates } = await window.api.templates.list()
        for (const template of templates) {
          if (targets.includes(template.name)) {
            await window.api.templates.delete(template.id)
          }
        }
      }, names)
      .catch(() => undefined)
  })

  test('saves a note as a template from the note menu and applies it to a fresh note', async ({
    page
  }) => {
    await ready(page)

    const noteTitle = uniqueLabel('Save As Template Source')
    const templateName = uniqueLabel('Saved Template')
    const freshNoteTitle = uniqueLabel('Template Target')
    templateNames = [noteTitle, templateName]

    const noteId = await seedNote(page, noteTitle, NOTE_BODY)

    await page.evaluate(
      async ({ id, tag, propertyName, propertyValue }) => {
        const tagged = await window.api.notes.update({ id, tags: [tag] })
        if (!tagged.success) {
          throw new Error(tagged.error ?? 'note tag update failed')
        }
        const propertied = await window.api.properties.set(id, { [propertyName]: propertyValue })
        if (!propertied.success) {
          throw new Error(propertied.error ?? 'note property set failed')
        }
      },
      { id: noteId, tag: NOTE_TAG, propertyName: PROPERTY_NAME, propertyValue: PROPERTY_VALUE }
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
      { id: noteId, title: noteTitle, key: storageKey }
    )
    await page.reload()
    await ready(page)
    await page.locator(SELECTORS.noteEditor).first().waitFor({ state: 'visible', timeout: 20_000 })
    await expect(page.locator(SELECTORS.noteTitle).first()).toHaveValue(noteTitle)

    await page.locator('[data-testid="note-more-menu"]').first().click()
    await page.getByRole('option', { name: 'Save as Template' }).click()

    const dialog = page.getByTestId('save-note-as-template-dialog')
    await expect(dialog).toBeVisible()

    const nameInput = dialog.getByRole('textbox', { name: 'Template name' })
    await expect(nameInput, 'the name is pre-filled with the note title').toHaveValue(noteTitle)
    await nameInput.fill(templateName)
    await dialog.getByRole('button', { name: 'Save template' }).click()

    await expect(page.getByText('Template saved').first()).toBeVisible({ timeout: 10_000 })
    await expect(dialog).toBeHidden()
    await expect(
      page.locator(SELECTORS.noteTitle).first(),
      'saving leaves the user on the note'
    ).toHaveValue(noteTitle)

    const saved = await page.evaluate(
      async ({ id, name }) => {
        const note = await window.api.notes.get(id)
        const { templates } = await window.api.templates.list()
        const listed = templates.find((candidate) => candidate.name === name)
        return {
          noteContent: note?.content ?? null,
          noteTags: note?.tags ?? [],
          template: listed ? await window.api.templates.get(listed.id) : null
        }
      },
      { id: noteId, name: templateName }
    )

    const template = saved.template
    if (!template) {
      throw new Error(`the dialog did not create a template named "${templateName}"`)
    }

    expect(saved.noteTags).toContain(NOTE_TAG)
    expect(template.tags, 'the template carries the note tags').toEqual(saved.noteTags)
    expect(template.properties, 'the template carries the note properties').toEqual([
      expect.objectContaining({ name: PROPERTY_NAME, type: 'text', value: PROPERTY_VALUE })
    ])
    expect(template.content, 'the template carries the note body verbatim').toBe(saved.noteContent)

    const applied = await page.evaluate(
      async ({ templateId, title }) => {
        const created = await window.api.notes.create({ title, content: '' })
        const freshNoteId = created.note?.id
        if (!freshNoteId) {
          throw new Error(created.error ?? 'fresh note create failed')
        }
        const result = await window.api.notes.applyTemplate({
          noteId: freshNoteId,
          templateId,
          mode: 'full'
        })
        if (!result.success) {
          throw new Error(result.error ?? 'apply template failed')
        }
        const fresh = await window.api.notes.get(freshNoteId)
        return { content: fresh?.content ?? null, tags: fresh?.tags ?? [] }
      },
      { templateId: template.id, title: freshNoteTitle }
    )

    expect(
      normalizeBodyText(applied.content ?? ''),
      'the fresh note ends up with the source note body'
    ).toBe(normalizeBodyText(saved.noteContent ?? ''))
    expect(normalizeBodyText(applied.content ?? '')).toBe(NOTE_BODY)
    expect(applied.tags, 'the fresh note inherits the source note tags').toContain(NOTE_TAG)

    await page.evaluate(async (templateId) => {
      await window.api.templates.delete(templateId)
    }, template.id)

    await expect
      .poll(
        async () =>
          page.evaluate(async (name) => {
            const { templates } = await window.api.templates.list()
            return templates.some((candidate) => candidate.name === name)
          }, templateName),
        { message: 'the template is gone once deleted', timeout: 10_000 }
      )
      .toBe(false)
  })
})
