// Throwaway probe for #4632: test 2 of portals.e2e.ts with state dumps around the `((` step.
import { expectSuggestionMenuOpen, noteBody, openNewNote, typeInEditor } from '../../harness/editor'
import {
  NOTE_EDITOR,
  NOTE_TITLE,
  createNote,
  openFromSidebar,
  vaultOpen
} from '../../harness/notes'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'

const TIMEOUT = { timeout: 30_000 }
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const SPLIT = '[data-testid="split-pane"]'

const diag = (page: Page, label: string): Promise<void> =>
  page
    .evaluate((sel: string) => {
      const describe = (n: Node | null): string => {
        const el = n instanceof Element ? n : (n?.parentElement ?? null)
        if (!el) return String(n)
        const pane = el.closest('[data-pane-active]')
        const editors = Array.from(document.querySelectorAll(sel))
        const ed = editors.findIndex((e) => e.contains(el))
        return `${el.tagName}.${(el.className || '').toString().slice(0, 40)} pane=${pane?.getAttribute('data-pane-active')} editor#${ed}`
      }
      const sel2 = getSelection()
      return JSON.stringify({
        hasFocus: document.hasFocus(),
        active: describe(document.activeElement),
        selAnchor: describe(sel2?.anchorNode ?? null),
        selOffset: sel2?.anchorOffset,
        panes: Array.from(document.querySelectorAll('[data-pane-active]')).map((p) => ({
          active: p.getAttribute('data-pane-active'),
          rect: JSON.stringify(p.getBoundingClientRect()),
          title: (
            p.querySelector('textarea[aria-label="Note title"]') as HTMLTextAreaElement | null
          )?.value,
          editors: Array.from(p.querySelectorAll(sel)).map((e) => ({
            expanded: e.getAttribute('aria-expanded'),
            text: (e.textContent ?? '').slice(0, 120),
            rect: JSON.stringify(e.getBoundingClientRect())
          }))
        })),
        editorsInDom: Array.from(document.querySelectorAll(sel)).map(
          (e) =>
            `${e.closest('[data-pane-active]')?.getAttribute('data-pane-active')}:${(e.textContent ?? '').slice(0, 40)}`
        ),
        win: [innerWidth, innerHeight]
      })
    }, NOTE_EDITOR)
    .then((s) => console.log(`[probe4632] ${label} ${s}`))
    .catch((e) => console.log(`[probe4632] ${label} diag failed ${String(e)}`))

test('probe: the source open in another pane shows its usage chip as the portal is inserted', async ({
  page
}) => {
  test.setTimeout(180_000)
  await vaultOpen(page)
  const stamp = Date.now().toString(36)
  const word = `velquor${stamp}`
  const anchor = `lv${stamp}`
  const source = await createNote(page, {
    title: `Live source ${stamp}`,
    content: `Intro line\n\nThe ${word} block ^${anchor}`
  })
  await openFromSidebar(page, source)
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
  await diag(page, 'before-click')
  await page.locator(`[data-pane-active="true"] ${NOTE_EDITOR}`).click()
  await diag(page, 'after-click')

  await typeInEditor(page, '((')
  await diag(page, 'after-type')
  try {
    await expectSuggestionMenuOpen(page)
  } catch (error) {
    await diag(page, 'FAILED')
    console.log(`[probe4632] FAILED host body ${JSON.stringify(await noteBody(page, host.id))}`)
    console.log(`[probe4632] FAILED source body ${JSON.stringify(await noteBody(page, source.id))}`)
    throw error
  }
  await typeInEditor(page, word)
  await expectSuggestionMenuOpen(page, `The ${word} block`)
  await page.keyboard.press('Enter')

  await expect.poll(async () => (await noteBody(page, host.id)) ?? '', TIMEOUT).toContain(anchor)
  await expect(sourceChip).toHaveText('1', TIMEOUT)
})
