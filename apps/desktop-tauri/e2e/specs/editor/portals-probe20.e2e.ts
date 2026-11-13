// A block portal inserted through the `((` picker (#4415): the block row comes from
// `portals_search`, picking it stamps the source block's anchor (`portals_stamp_anchor`), the
// source then shows the usage chip (`portals_get_usage`), and both survive a restart. The
// picker's note rows come from `window.api.search`, which is not ported yet: that half answers
// empty and the block half still lists the row. With the source open in a second pane while the
// picker inserts, its usage chip appears there live, from `portals:usage-changed`.
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
  const t0 = Date.now()
  const timeline: string[] = []
  const sample = async (): Promise<string[]> => {
    const snap = await page.evaluate(() => {
      const w = window as unknown as {
        __memryActiveEditor?: { document: Array<{ type: string; props?: { language?: string } }> }
      }
      const types = (w.__memryActiveEditor?.document ?? []).map(
        (b) => b.type + (b.props?.language ? ':' + b.props.language : '')
      )
      return {
        has: !!w.__memryActiveEditor,
        types,
        editors: document.querySelectorAll('.bn-editor').length,
        titles: Array.from(document.querySelectorAll('input'))
          .map((i) => (i as HTMLInputElement).value)
          .slice(0, 3),
        tabs: document.querySelectorAll('[role="tab"]').length
      }
    })
    timeline.push(`${Date.now() - t0}ms ${JSON.stringify(snap)}`)
    return portalDefinitions(page)
  }
  try {
    await expect.poll(sample, TIMEOUT).toHaveLength(1)
    const defs = await sample()
    expect(defs[0]).toContain(anchor)
  } catch (error) {
    const last = timeline.slice(-12).join('\n')
    const first = timeline.slice(0, 4).join('\n')
    const hostBody = await noteBody(page, host.id)
    throw new Error(
      `PROBE ${(error as Error).message}\nFIRST:\n${first}\nLAST:\n${last}\nsamples=${timeline.length}\nhostBody=${JSON.stringify(hostBody)}`,
      { cause: error }
    )
  }
})
