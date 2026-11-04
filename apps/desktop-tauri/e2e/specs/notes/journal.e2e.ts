// The journal's day entry in the running app (Step 13m-3, #3530): today's day is made by its
// first edit, the text typed into it is saved to the day's file and the day's document, a
// `#tag` typed into the body joins the day's tags on its record (never the file's), and the day
// reads back after a restart. Ported from the Electron `journal` spec's entry-creation and
// tag cases, which asserted nothing; the calendar and heatmap cases move with 13m-4.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { browser } from '@wdio/globals'

import { navigateTo, waitForAppReady } from '../../harness/app-helpers'
import { restart } from '../../harness/tauri-lifecycle'
import type { Page } from '../../harness/pw-compat/page'
import { test, expect } from '../../harness/test'
import { vaultStatus } from '../../harness/vault-commands'
import { pollUntil } from '../../harness/wait'

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

/**
 * Types at the end of the day's text. WebKit's driver sends key actions to no editable
 * element, so the keys go to the editor itself (WebDriver Element Send Keys).
 */
async function typeInDay(page: Page, text: string): Promise<void> {
  await expect(page.locator('.bn-editor').first()).toBeVisible()
  const driver = browser as unknown as ElementKeys
  const editor = await driver.findElement('css selector', '.bn-editor')
  await driver.elementSendKeys(Object.values(editor)[0], text)
}

test('typing into today saves the day to its file and its document', async ({
  app,
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  expect(await entry(page, date)).toBeNull()

  await typeInDay(page, 'Today I am testing the journal.')
  const saved = await pollUntil(
    async () => {
      const day = await entry(page, date)
      return day?.content.includes('testing the journal') ? day : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(saved?.id).toBe(`j${date}`)
  expect(existsSync(file)).toBe(true)
  const text = readFileSync(file, 'utf8')
  expect(text).toContain(`date: '${date}'`)
  expect(text).toContain('Today I am testing the journal.')

  await restart(app)
  await openJournal(page)
  await expect(page.locator('.bn-editor').first()).toContainText('Today I am testing the journal.')
})

test('a #tag typed into a day joins its tags on the record, and the file keeps its own', async ({
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  // The first edit makes the day, whose new file says its tags, as Electron's create writes.
  await typeInDay(page, 'Thinking today.')
  expect(await pollUntil(async () => existsSync(file), { timeoutMs: 20_000 })).toBe(true)

  await typeInDay(page, ' About #reflection now. ')
  const tagged = await pollUntil(
    async () => {
      const day = await entry(page, date)
      return day?.tags.includes('reflection') ? day : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(tagged?.tags).toEqual(['reflection'])
  const text = await pollUntil(
    async () => {
      const read = readFileSync(file, 'utf8')
      return read.includes('#reflection') ? read : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(text).not.toMatch(/^tags:/m)
})
