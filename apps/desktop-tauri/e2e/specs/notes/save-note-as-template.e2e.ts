// Saving a note as a template from the note page's menu, ported from Electron's
// `save-note-as-template.e2e.ts` (Step 13q-4, #3530): the dialog reads the note and its
// properties (`notes_get`, `properties_get`), saves through `templates_create`, and the template
// applied to a fresh note gives it the source note's body and tags. Each test runs on its own
// vault, so nothing is cleaned up between them.
import type { Page } from '../../harness/pw-compat/page'
import { normalizeBodyText } from '../../harness/note-sync-helpers'
import { test, expect } from '../../harness/test'
import { invoke, vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

const NOTE_BODY = '# Retro agenda\n\nWhat went well, what to change, owners for next week.'
const NOTE_TAG = 'e2e-save-as-template'
const PROPERTY_NAME = 'Stage'
const PROPERTY_VALUE = 'Draft'
const NOTE_TITLE = 'textarea[aria-label="Note title"]'

interface NoteView {
  id: string
  path: string
  title: string
  content: string
  tags: string[]
}

interface Template {
  id: string
  name: string
  tags: string[]
  properties: Array<{ name: string; type: string; value: unknown }>
  content: string
}

const stamp = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

async function ready(page: Page): Promise<void> {
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
}

/** Opens a vault-root note from the Collections tree, as a user does. */
async function openFromSidebar(page: Page, note: NoteView): Promise<void> {
  const header = page.locator('#section-header-collections')
  await expect(header).toBeVisible({ timeout: 30_000 })
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click()
  await page.locator(`[data-tree-node-id="${note.id}"]`).click()
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(note.title)
}

async function templateNamed(page: Page, name: string): Promise<{ id: string } | undefined> {
  const listed = await invoke<Array<{ id: string; name: string }>>(page, 'templates_list')
  return listed.find((candidate) => candidate.name === name)
}

test('saves a note as a template from the note menu and applies it to a fresh note', async ({
  page
}) => {
  await ready(page)
  const noteTitle = `Save As Template Source ${stamp()}`
  const templateName = `Saved Template ${stamp()}`

  const note = await invoke<NoteView>(page, 'notes_create', {
    input: { title: noteTitle, content: NOTE_BODY }
  })
  await invoke(page, 'notes_update', { input: { id: note.id, headerTags: { add: [NOTE_TAG] } } })
  await invoke(page, 'properties_merge', {
    entityId: note.id,
    values: { [PROPERTY_NAME]: PROPERTY_VALUE }
  })

  await openFromSidebar(page, note)
  await page.getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('option', { name: 'Save as Template', exact: true }).click()

  const dialog = page.getByTestId('save-note-as-template-dialog')
  await expect(dialog).toBeVisible()
  const nameInput = dialog.getByRole('textbox', { name: 'Template name' })
  // The name starts as the note title.
  await expect(nameInput).toHaveValue(noteTitle)
  await nameInput.fill(templateName)
  await dialog.getByRole('button', { name: 'Save template' }).click()

  await expect(page.getByText('Template saved').first()).toBeVisible({ timeout: 10_000 })
  await expect(dialog).toBeHidden()
  // Saving leaves the user on the note.
  await expect(page.locator(NOTE_TITLE).first()).toHaveValue(noteTitle)

  const saved = await invoke<NoteView>(page, 'notes_get', { id: note.id })
  const listed = await templateNamed(page, templateName)
  if (!listed) throw new Error(`the dialog did not create a template named "${templateName}"`)
  const template = await invoke<Template>(page, 'templates_get', { id: listed.id })

  expect(saved.tags).toContain(NOTE_TAG)
  // The template carries the note's tags, properties and body.
  expect(template.tags).toEqual(saved.tags)
  expect(template.properties).toMatchObject([
    { name: PROPERTY_NAME, type: 'text', value: PROPERTY_VALUE }
  ])
  expect(template.properties).toHaveLength(1)
  expect(template.content).toBe(saved.content)

  const fresh = await invoke<NoteView>(page, 'notes_create', {
    input: { title: `Template Target ${stamp()}`, content: '' }
  })
  await invoke(page, 'notes_apply_template', {
    input: { noteId: fresh.id, templateId: template.id, mode: 'full' }
  })
  const applied = await invoke<NoteView>(page, 'notes_get', { id: fresh.id })

  // The fresh note ends up with the source note's body and tags.
  expect(normalizeBodyText(applied.content)).toBe(normalizeBodyText(saved.content))
  expect(normalizeBodyText(applied.content)).toBe(NOTE_BODY)
  expect(applied.tags).toContain(NOTE_TAG)

  await invoke(page, 'templates_delete', { id: template.id })
  expect(await templateNamed(page, templateName)).toBeUndefined()
})
