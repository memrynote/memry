// A block portal inserted through the `((` picker (#4415): the block row comes from
// `portals_search`, picking it stamps the source block's anchor (`portals_stamp_anchor`), the
// source then shows the usage chip (`portals_get_usage`), and both survive a restart. The
// picker's note rows come from `window.api.search`, which is not ported yet: that half answers
// empty and the block half still lists the row. With the source open in a second pane while the
// picker inserts, its usage chip appears there live, from `portals:usage-changed`.
import { expectSuggestionMenuOpen, noteBody, openNewNote, typeInEditor } from '../../harness/editor'
import {
  NOTE_EDITOR,
  NOTE_TITLE,
  createNote,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { restart } from '../../harness/tauri-lifecycle'
import { test, expect } from '../../harness/test'

const TIMEOUT = { timeout: 30_000 }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
/** The container of two panes side by side. */
const SPLIT = '[data-testid="split-pane"]'
const ANCHOR = /\s\^([a-z0-9][a-z0-9-]{3,31})\s*$/m

const usageChip = (page: Page, anchor: string) =>
  page.locator(`.memry-portal-usage-chip[data-anchor="${anchor}"]`)

/**
 * The definition text of each portal block the open note renders, read from the DOM in one
 * evaluate. `__memryActiveEditor` is the tab's newest editor, and every portal's window is a
 * nested editor on the SOURCE note that mounts once it scrolls near and its note loads, so after
 * a restart the handle moves from the note's own editor to the window's at a moment the spec
 * cannot pick.
 */
const portalDefinitions = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-memry-portal] code[data-node-view-content]')).map(
      (code) => code.textContent ?? ''
    )
  )

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
  await expect.poll(async () => (await portalDefinitions(page))[0] ?? '', TIMEOUT).toContain(anchor)
})

test('the source open in another pane shows its usage chip as the portal is inserted', async ({
  page
}) => {
  test.setTimeout(180_000)
  await vaultOpen(page)
  const stamp = Date.now().toString(36)
  const word = `velquor${stamp}`
  // Anchored already: picking the block stamps nothing, so the source's document never changes
  // and only `portals:usage-changed` can tell its pane that a host now shows the block.
  const anchor = `lv${stamp}`
  const source = await createNote(page, {
    title: `Live source ${stamp}`,
    content: `Intro line\n\nThe ${word} block ^${anchor}`
  })
  await openFromSidebar(page, source)
  // `tabs.splitRight` clones the source into a new pane on the right; the left pane stays active.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await expect(page.locator(SPLIT)).toHaveCount(0)
  await page.keyboard.press(`${MOD}+\\`)
  await expect(page.locator(SPLIT)).toHaveCount(1, TIMEOUT)
  const host = await openNewNote(page, `Live host ${stamp}`)
  const sourceChip = page.locator(
    `[data-pane-active="false"] .memry-portal-usage-chip[data-anchor="${anchor}"]`
  )
  await expect(page.locator('[data-pane-active="false"] ' + NOTE_TITLE)).toHaveValue(source.title)
  await expect(sourceChip).toHaveCount(0)
  await page.locator(NOTE_EDITOR).first().click()

  await typeInEditor(page, '((')
  await expectSuggestionMenuOpen(page)
  await typeInEditor(page, word)
  await expectSuggestionMenuOpen(page, `The ${word} block`)
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await noteBody(page, host.id)) ?? '', TIMEOUT).toContain(anchor)
  await expect(sourceChip).toHaveText('1', TIMEOUT)
})
