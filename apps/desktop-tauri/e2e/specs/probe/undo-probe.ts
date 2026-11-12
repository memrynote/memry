// Tags with fields in the running app (Step 13j-3, #3530), ported from Electron's
// `tags-with-fields.e2e.ts`: the tag hub's ready-made tags write a tag's fields, its related
// tags and its template, the strip stays dismissed over a restart, and a template a header tag
// brings can be undone and brought back. The relation picker, Linked here and the field rename
// of Electron's first test wait for 13j-3c and 13j-3d.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SELECTORS } from '../../harness/app-helpers'
import { createNote, openFromSidebar } from '../../harness/notes'

import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultOpen } from '../../harness/tags'

const STRIP = 'section[aria-labelledby="preset-offer-title"]'

async function openTagHub(page: Page): Promise<void> {
  await page.locator('button[aria-label="Open tag hub"]').click()
  await expect(page.getByRole('button', { name: /New tag/ })).toBeVisible({ timeout: 10_000 })
}

/** Adds the ready-made tag `key` from its card in the strip, unless it is already added. */
async function addPreset(page: Page, key: string): Promise<void> {
  const card = page.locator(`${STRIP} > div.grid > div`).filter({ hasText: new RegExp(`^${key}`) })
  const add = card.getByRole('button', { name: 'Add', exact: true })
  // The strip renders once the schema snapshot answers, after the hub opens; `isVisible` does not
  // wait, and read before that it skipped the click.
  await expect(card.getByRole('button', { name: /^Add(ed)?$/ })).toBeVisible()
  if (await add.isVisible()) await add.click()
  await expect(card.getByRole('button', { name: 'Added' })).toBeVisible({ timeout: 10_000 })
}

async function addHeaderTag(page: Page, tag: string): Promise<void> {
  // With tags present the tags row owns the add button; otherwise it lives in the details menu.
  const rowAddTag = page.getByRole('button', { name: 'Add tag', exact: true }).first()
  if (await rowAddTag.isVisible()) {
    await rowAddTag.click()
  } else {
    // The "add details" row takes pointer events only while the header is hovered, which a
    // WebDriver pointer move does not do in WKWebView, so its menu opens from the keyboard.
    const details = page.getByTestId('ghost-add-details')
    await details.waitFor({ state: 'attached' })
    await details.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('menuitem', { name: 'Add tag', exact: true }).click()
  }
  await page.getByPlaceholder(/tag/i).last().fill(tag)
  await page.keyboard.press('Enter')
}

function dumpUndo(page: Page, file: string): Promise<string> {
  return page.evaluate((fileText: string) => {
    const toasts = Array.from(document.querySelectorAll('[data-sonner-toast]')).map((el) => ({
      text: (el.textContent ?? '').slice(0, 90),
      mounted: el.getAttribute('data-mounted'),
      visible: el.getAttribute('data-visible'),
      removed: el.getAttribute('data-removed'),
      rect: JSON.stringify(el.getBoundingClientRect())
    }))
    const w = window as unknown as { __clicks: unknown[] }
    return JSON.stringify({
      toasts,
      editor: document.querySelector('.bn-editor')?.textContent?.slice(0, 80),
      fileHasContext: fileText.includes('Context'),
      fileLen: fileText.length,
      clicks: w.__clicks,
      hf: document.hasFocus()
    })
  }, file)
}

export function undoLoop(group: number, count: number): void {
  for (let i = 0; i < count; i++) {
    test(`probe ${group}.${i}`, async ({ page, testVaultPath }) => {
      await vaultOpen(page)
      await openTagHub(page)
      await addPreset(page, 'person')
      const title = `Again ${Date.now().toString(36)}`
      const note = await createNote(page, { title, content: '', folder: 'notes' })
      await openFromSidebar(page, note)
      const editor = page.locator(SELECTORS.noteEditor).first()
      const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'is now a person' })
      const file = (): string => readFileSync(join(testVaultPath, note.path), 'utf8')
      await addHeaderTag(page, 'person')
      await expect(toast).toBeVisible({ timeout: 10_000 })
      await expect(editor).toContainText('Context')
      await page.evaluate(() => {
        const w = window as unknown as { __clicks: unknown[] }
        const t0 = performance.now()
        w.__clicks = []
        window.addEventListener(
          'click',
          (e) => {
            const el = e.target as HTMLElement
            w.__clicks.push({
              t: Math.round(performance.now() - t0),
              tag: el.tagName,
              text: (el.textContent ?? '').slice(0, 30)
            })
          },
          true
        )
      })
      await toast.getByRole('button', { name: 'Undo' }).click()
      try {
        await expect(editor).not.toContainText('Context', { timeout: 8000 })
      } catch (error) {
        throw new Error(
          `PROBE-UNDO ${(error as Error).message.slice(0, 100)} ${await dumpUndo(page, file())}`,
          { cause: error }
        )
      }
    })
  }
}
