// The journal's day entry in the running app (Step 13m-3, #3530): today's day is made by its
// first edit, the text typed into it is saved to the day's file and the day's document, a
// `#tag` typed into the body joins the day's tags on its record (never the file's), and the day
// reads back after a restart. Ported from the Electron `journal` spec's entry-creation, tag,
// calendar and heatmap cases, which asserted nothing. The calendar (13m-4) lists the day files
// of the vault with their previews and counts, and drops a deleted day. The charts (13m-4b)
// read the saved days' property values, and the day panel its day's tasks.
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

interface MonthEntry {
  date: string
  preview: string
  activityLevel: number
}

async function monthEntries(page: Page, year: number, month: number): Promise<MonthEntry[]> {
  return (await page.evaluate(
    (args) => window.__TAURI__.core.invoke('journal_get_month_entries', args),
    { year, month }
  )) as MonthEntry[]
}

test('the calendar shows the saved days of the month and year, and drops a deleted day', async ({
  page
}) => {
  await waitForAppReady(page)
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  const date = await today(page)
  const [year, month] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))]
  const [first, second] = [`${date.slice(0, 8)}01`, `${date.slice(0, 8)}02`]
  const create = (input: { date: string; content: string; tags?: string[] }) =>
    page.evaluate((args) => window.__TAURI__.core.invoke('journal_create_entry', args), { input })
  await create({ date: first, content: 'Walked by the river.' })
  await create({ date: second, content: 'Read a **book**.', tags: ['books'] })

  // The first read after the saves has their counts: each save answers once its day is measured.
  const listed = await monthEntries(page, year, month)
  expect(listed.map((day) => [day.date, day.preview, day.activityLevel])).toEqual([
    [second, 'Read a book.', 1],
    [first, 'Walked by the river.', 1]
  ])
  const heatmap = (await page.evaluate(
    (y) => window.__TAURI__.core.invoke('journal_get_heatmap', { year: y }),
    year
  )) as { date: string; level: number }[]
  expect(heatmap.map((day) => [day.date, day.level])).toEqual([
    [first, 1],
    [second, 1]
  ])

  await navigateTo(page, 'journal')
  const dateNav = page.locator('nav[aria-label="Journal date navigation"]')
  const monthName = await page.evaluate(() => new Date().toLocaleString('en-US', { month: 'long' }))
  await dateNav.getByRole('button', { name: monthName, exact: true }).click()
  await expect(page.getByText('Walked by the river.')).toBeVisible()
  await expect(page.getByText('Read a book.')).toBeVisible()

  await page.getByRole('button', { name: 'Go to year view' }).click()
  await expect(page.getByText('2 days', { exact: true })).toBeVisible()

  // A deleted day leaves the calendar.
  expect(
    await page.evaluate(
      (day) => window.__TAURI__.core.invoke('journal_delete_entry', { date: day }),
      second
    )
  ).toEqual({ success: true })
  await expect(page.getByText('1 day', { exact: true })).toBeVisible()
  expect((await monthEntries(page, year, month)).map((day) => day.date)).toEqual([first])
})

test('the charts read the saved days property values, and the day panel its tasks', async ({
  page
}) => {
  await waitForAppReady(page)
  expect(await pollUntil(async () => (await vaultStatus(page)).isOpen, { timeoutMs: 30_000 })).toBe(
    true
  )
  const date = await today(page)
  const [first, second] = [`${date.slice(0, 8)}01`, `${date.slice(0, 8)}02`]
  const invoke = (cmd: string, args: Record<string, unknown>) =>
    page.evaluate((call) => window.__TAURI__.core.invoke(call.cmd, call.args), { cmd, args })
  await invoke('journal_create_entry', {
    input: { date: first, content: 'Slept well.', properties: { mood: 4 } }
  })
  await invoke('journal_create_entry', { input: { date: second, content: 'Tired.' } })
  await invoke('journal_update_entry', {
    input: { date: second, properties: { mood: 2, weather: 'rain' } }
  })

  const read = (await invoke('journal_get_property_rows', { from: first, to: second })) as {
    rows: { date: string; properties: Record<string, unknown> }[]
    properties: { name: string; type: string; count: number }[]
  }
  expect(read.rows.map((row) => [row.date, row.properties])).toEqual([
    [first, { mood: 4 }],
    [second, { mood: 2, weather: 'rain' }]
  ])
  expect(read.properties).toEqual([
    { name: 'mood', type: 'number', count: 2 },
    { name: 'weather', type: 'text', count: 1 }
  ])

  expect(await invoke('journal_get_day_context', { date: first })).toEqual({
    date: first,
    tasks: [],
    events: [],
    overdueCount: 0
  })
})
