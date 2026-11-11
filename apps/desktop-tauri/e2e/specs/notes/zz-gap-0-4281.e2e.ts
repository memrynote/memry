import { closeSync, fstatSync, openSync, readFileSync, statSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import { browser } from '@wdio/globals'

import { navigateTo, waitForAppReady } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil, sleep } from '../../harness/wait'

interface Entry {
  id: string
  content: string
  tags: string[]
}

/** The renderer's today, as the journal page picks it. */
async function today(page: Page): Promise<string> {
  return page.evaluate(() => {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  })
}

async function entry(page: Page, date: string): Promise<Entry | null> {
  return (await page.evaluate(
    (day) => window.__TAURI__.core.invoke('journal_get_entry', { date: day }),
    date
  )) as Entry | null
}

async function openJournal(page: Page): Promise<void> {
  await waitForAppReady(page)
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  await navigateTo(page, 'journal')
}

/** The two WebDriver protocol commands `typeInDay` sends. */
interface ElementKeys {
  findElement(using: 'css selector', value: string): Promise<Record<string, string>>
  elementSendKeys(elementId: string, text: string): Promise<void>
}

/** The day's editor once its day has loaded: the one shown while it loads takes no input. */
const DAY_EDITOR = '.bn-editor[contenteditable="true"]'

/**
 * Types at the end of the day's text. WebKit's driver sends key actions to no editable
 * element, so the keys go to the editor itself (WebDriver Element Send Keys).
 */
async function typeInDay(page: Page, text: string): Promise<void> {
  await expect(page.locator(DAY_EDITOR).first()).toBeVisible()
  const driver = browser as unknown as ElementKeys
  const editor = await driver.findElement('css selector', DAY_EDITOR)
  await driver.elementSendKeys(Object.values(editor)[0], text)
}
const timesIn = (text: string, part: string): number => text.split(part).length - 1
const GAP = 0
const ROUNDS = 8

test('zz4281 gap 0 loop', async ({ app, page, testVaultPath }) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written first.')
  await pollUntil(
    async () => ((await entry(page, date))?.content.includes('Written first.') ? true : undefined),
    { timeoutMs: 20_000 }
  )
  const editor = page.locator(DAY_EDITOR).first()
  const lost: number[] = []
  for (let round = 1; round <= ROUNDS; round++) {
    const typed = ` Typed ${round}.`
    const outside = `Outside ${round}.`
    await typeInDay(page, typed)
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Previous day"]')?.click()
    })
    const next = `${readFileSync(file, 'utf8').trimEnd()}\n\n${outside}\n`
    const fd = openSync(file, 'w')
    if (GAP > 0) await sleep(GAP)
    writeSync(fd, next)
    const orphan = fstatSync(fd).ino !== statSync(file).ino
    closeSync(fd)
    const saved = await pollUntil(
      async () => {
        const text = readFileSync(file, 'utf8')
        return text.includes(typed.trim()) ? text : undefined
      },
      { timeoutMs: 20_000 }
    )
    await sleep(1_500)
    const text = readFileSync(file, 'utf8')
    let inVersion = false
    if (!text.includes(outside)) {
      const versions = await invokeTest<{ content: string }[]>(app, 'e2e_debug_query', {
        sql: `SELECT content FROM note_snapshots WHERE note_id = 'j${date}'`
      })
      inVersion = versions.some((version) => version.content.includes(outside))
    }
    const ok = text.includes(outside) || inVersion
    console.log(
      'Z4281',
      round,
      JSON.stringify({
        gap: GAP,
        orphan,
        saved: saved !== undefined,
        inFile: text.includes(outside),
        inVersion,
        typed: timesIn(text, typed.trim()),
        first: timesIn(text, 'Written first.')
      })
    )
    if (!ok) {
      lost.push(round)
      console.log('Z4281 LOST', round, JSON.stringify(text))
    }
    await page.getByRole('button', { name: 'Next day' }).first().click()
    await expect(editor).toContainText(typed.trim())
  }
  console.log('Z4281 SUMMARY', JSON.stringify(lost))
  expect(lost).toEqual([])
})
