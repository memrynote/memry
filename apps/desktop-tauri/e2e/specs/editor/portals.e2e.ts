// A block portal inserted through the `((` picker (#4415): the block row comes from
// `portals_search`, picking it stamps the source block's anchor (`portals_stamp_anchor`), the
// source then shows the usage chip (`portals_get_usage`), and both survive a restart. The
// picker's note rows come from `window.api.search`, which is not ported yet: that half answers
// empty and the block half still lists the row.
import {
  editorDocument,
  expectSuggestionMenuOpen,
  noteBody,
  openNewNote,
  typeInEditor
} from '../../harness/editor'
import { NOTE_EDITOR, createNote, openFromSidebar, vaultOpen } from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

const TIMEOUT = { timeout: 30_000 }
const ANCHOR = /\s\^([a-z0-9][a-z0-9-]{3,31})\s*$/m

const usageChip = (page: Page, anchor: string) =>
  page.locator(`.memry-portal-usage-chip[data-anchor="${anchor}"]`)

/** The open note's portal blocks, as the code block text that defines each. */
async function portalDefinitions(page: Page): Promise<string[]> {
  const doc = await editorDocument(page)
  return doc
    .filter((block) => block.type === 'codeBlock' && block.props?.language === 'memry-portal')
    .map((block) =>
      Array.isArray(block.content) ? block.content.map((part) => part.text ?? '').join('') : ''
    )
}

test('a block portal picked by search shows its usage on the source and survives a restart', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await vaultOpen(page)
  const stamp = Date.now().toString(36)
  const word = `quorvex${stamp}`
  const source = await createNote(page, {
    title: `Portal source ${stamp}`,
    content: `Intro line\n\nThe ${word} block`
  })
  const host = await openNewNote(page, `Portal host ${stamp}`)
  await page.locator(NOTE_EDITOR).first().click()

  await typeInEditor(page, '((')
  await expectSuggestionMenuOpen(page)
  await typeInEditor(page, word)
  await expectSuggestionMenuOpen(page, `The ${word} block`)
  await page.keyboard.press('Enter')

  let anchor = ''
  await expect
    .poll(async () => {
      anchor = ANCHOR.exec((await noteBody(page, source.id)) ?? '')?.[1] ?? ''
      return anchor
    }, TIMEOUT)
    .not.toBe('')
  expect(await noteBody(page, source.id)).toContain(`The ${word} block ^${anchor}`)
  await expect
    .poll(async () => (await noteBody(page, host.id)) ?? '', TIMEOUT)
    .toContain('```memry-portal')
  expect(await noteBody(page, host.id)).toContain(anchor)

  await openFromSidebar(page, source)
  await expect(usageChip(page, anchor)).toHaveText('1', TIMEOUT)

  await restart(app)
  await vaultOpen(page)
  await openFromSidebar(page, source)
  await expect(usageChip(page, anchor)).toHaveText('1', TIMEOUT)
  await openFromSidebar(page, host)
  await expect.poll(() => portalDefinitions(page), TIMEOUT).toHaveLength(1)
  expect((await portalDefinitions(page))[0]).toContain(anchor)
})
