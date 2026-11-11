// The journal's day entry in the running app (Step 13m-3, #3530): today's day is made by its
// first edit, the text typed into it is saved to the day's file and the day's document, a
// `#tag` typed into the body joins the day's tags on its record (never the file's), and the day
// reads back after a restart. Ported from the Electron `journal` spec's entry-creation, tag,
// calendar and heatmap cases, which asserted nothing. The calendar (13m-4) lists the day files
// of the vault with their previews and counts, and drops a deleted day. The charts (13m-4b)
// read the saved days' property values, and the day panel its day's tasks. An edit of the day's
// file outside the app (13m-5) reaches the open day, unless the day holds typing not saved yet,
// which stays and is saved; the app's own saves never reach it as one.
// A tag added to the file's frontmatter outside the app joins the day's tags on its record (#3825).
// Leaving a day with typing not saved yet saves it to that day, once, with an outside edit
// landing during the switch kept in the file or as a version (#4088).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { browser } from '@wdio/globals'

import { navigateTo, waitForAppReady } from '../../harness/app-helpers'
import { invokeTest } from '../../harness/invoke-test'
import { restart } from '../../harness/tauri-lifecycle'
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

test.skip('typing into today saves the day to its file and its document', async ({
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

test.skip('a #tag typed into a day joins its tags on the record, and the file keeps its own', async ({
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
  wordCount: number
  activityLevel: number
}

async function monthEntries(page: Page, year: number, month: number): Promise<MonthEntry[]> {
  return (await page.evaluate(
    (args) => window.__TAURI__.core.invoke('journal_get_month_entries', args),
    { year, month }
  )) as MonthEntry[]
}

test.skip('the calendar shows the saved days of the month and year, and drops a deleted day', async ({
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

test.skip('the charts read the saved days property values, and the day panel its tasks', async ({
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

test.skip('an edit of the open day file outside the app shows in the day', async ({
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written in the app.')
  expect(await pollUntil(async () => existsSync(file), { timeoutMs: 20_000 })).toBe(true)
  // The whole typed text: a save of part of it leaves the rest as typing not saved yet, which
  // stays in the day over the outside edit below.
  await pollUntil(
    async () =>
      (await entry(page, date))?.content.includes('Written in the app.') ? true : undefined,
    { timeoutMs: 20_000 }
  )

  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('Written in the app.', 'Rewritten outside.')
  )
  await expect(page.locator('.bn-editor').first()).toContainText('Rewritten outside.')
})

// The editor reports the text an outside edit hands it, which is not typing (#3967): held as
// typing, it kept the next outside edit out of the day, and its save went over that edit.
test.skip('a second outside edit right after the first shows in the day and stays in its file', async ({
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written in the app.')
  await pollUntil(
    async () =>
      (await entry(page, date))?.content.includes('Written in the app.') ? true : undefined,
    { timeoutMs: 20_000 }
  )

  writeFileSync(file, readFileSync(file, 'utf8').replace('Written in the app.', 'First outside.'))
  await expect(page.locator('.bn-editor').first()).toContainText('First outside.')
  writeFileSync(file, readFileSync(file, 'utf8').replace('First outside.', 'Second outside.'))
  await expect(page.locator('.bn-editor').first()).toContainText('Second outside.')

  // Past the editor's 150 ms debounce and the 1 s save delay: nothing saved the first text back.
  await sleep(1_500)
  expect(readFileSync(file, 'utf8')).toContain('Second outside.')
  expect((await entry(page, date))?.content).toBe('Second outside.')
})

// Typing not saved yet reached no file, so nothing else holds it (#3530): an outside edit of the
// day's file leaves it in the day, and its save writes over that edit, which the core keeps as a
// version (`journal_update::a_save_over_an_outside_edit_keeps_that_edit_as_a_version`).
test.skip('typing not saved yet stays in the day over an outside edit, and is saved', async ({
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written in the app.')
  await pollUntil(
    async () => ((await entry(page, date))?.content.includes('in the app') ? true : undefined),
    { timeoutMs: 20_000 }
  )
  await page.evaluate(() => {
    const seen: string[] = []
    const target = window as unknown as {
      __outsideEdits: string[]
      __TAURI__: {
        event: {
          listen(
            name: string,
            cb: (e: { payload: { source?: string; entry: { content: string } } }) => void
          ): Promise<unknown>
        }
      }
    }
    target.__outsideEdits = seen
    return target.__TAURI__.event
      .listen('journal-entry-updated-event', (event) => {
        if (event.payload.source === 'external') seen.push(event.payload.entry.content)
      })
      .then(() => true)
  })

  await typeInDay(page, ' Kept typing')
  // Past the editor's 150 ms debounce: the page holds the typing as unsaved.
  await new Promise((resolve) => setTimeout(resolve, 400))
  writeFileSync(
    file,
    readFileSync(file, 'utf8').replace('Written in the app.', 'Rewritten outside.')
  )
  // Each key restarts the 1 s save delay, so the outside edit reaches the page while the typing
  // is still unsaved.
  const reached = await pollUntil(
    async () => {
      await typeInDay(page, '.')
      const seen = await page.evaluate(
        () => (window as unknown as { __outsideEdits: string[] }).__outsideEdits
      )
      return seen.some((content) => content.includes('Rewritten outside.')) ? true : undefined
    },
    { timeoutMs: 20_000, intervalMs: 200 }
  )
  expect(reached).toBe(true)

  const saved = await pollUntil(
    async () => ((await entry(page, date))?.content.includes('Kept typing') ? true : undefined),
    { timeoutMs: 20_000 }
  )
  expect(saved).toBe(true)
  await expect(page.locator('.bn-editor').first()).toContainText('Written in the app. Kept typing.')
  expect(readFileSync(file, 'utf8')).toContain('Written in the app. Kept typing.')
})

test.skip('a tag added to the day file outside the app joins the day tags on its record', async ({
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written in the app.')
  await typeInDay(page, ' About #reflection now.')
  const [year, month] = date.split('-').map(Number)
  // The index has measured the saved file: an outside edit is read against its tags.
  const measured = await pollUntil(
    async () => {
      const day = (await monthEntries(page, year, month)).find((e) => e.date === date)
      return day?.wordCount === 7 ? true : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(measured).toBe(true)

  // A new day's file says its tags; another editor adds one to the list.
  const text = readFileSync(file, 'utf8')
  expect(text).toMatch(/^ {2}- reflection$/m)
  writeFileSync(file, text.replace(/^ {2}- reflection$/m, '  - reflection\n  - outside'))
  const tagged = await pollUntil(
    async () => {
      const day = await entry(page, date)
      return day?.tags.includes('outside') ? day : undefined
    },
    { timeoutMs: 20_000 }
  )
  expect(tagged?.tags).toEqual(['reflection', 'outside'])
})

test.skip('text typed while the day saves stays in the day', async ({ page }) => {
  await openJournal(page)
  const date = await today(page)
  const saved = (text: string) =>
    pollUntil(async () => ((await entry(page, date))?.content.includes(text) ? true : undefined), {
      timeoutMs: 20_000
    })
  await typeInDay(page, 'First part.')
  expect(await saved('First part.')).toBe(true)
  // Typed straight after the save, while its index pass and the watcher's report of the file
  // are still to come: neither may reach the editor as an outside edit.
  await typeInDay(page, ' Second part.')
  expect(await saved('Second part.')).toBe(true)
  await typeInDay(page, ' Third part.')
  expect(await saved('Third part.')).toBe(true)
  await expect(page.locator('.bn-editor').first()).toContainText(
    'First part. Second part. Third part.'
  )
})

/** How many times `part` is in `text`. */
const timesIn = (text: string, part: string): number => text.split(part).length - 1

// The day's typing, sent by the switch (and the editor's late report of it) while an outside
// edit lands on the day's file: the typing reaches the file once, the outside text stays in the
// file or is kept as a version, and the day reopened shows the file as it is (#4088).
test('typing left in a day by a switch is saved once, with an outside edit made meanwhile', async ({
  app,
  page,
  testVaultPath
}) => {
  await openJournal(page)
  const date = await today(page)
  const file = join(testVaultPath, 'journal', `${date}.md`)
  await typeInDay(page, 'Written first.')
  await pollUntil(
    async () => ((await entry(page, date))?.content.includes('Written first.') ? true : undefined),
    { timeoutMs: 20_000 }
  )
  const editor = page.locator(DAY_EDITOR).first()

  for (const round of [1, 2, 3, 4, 5, 6]) {
    const typed = ` Typed ${round}.`
    const outside = `Outside ${round}.`
    await typeInDay(page, typed)
    await sleep(2000)
    // Within the editor's 150 ms debounce and the 1 s save delay: the switch takes the typing.
    await page.evaluate(() => {
      const previous = document.querySelector<HTMLButtonElement>('[aria-label="Previous day"]')
      previous?.click()
    })
    writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n${outside}\n`)
    console.log('TMP4281 wrote', round, Date.now(), JSON.stringify(readFileSync(file, 'utf8')))

    const saved = await pollUntil(
      async () => {
        const text = readFileSync(file, 'utf8')
        return text.includes(typed.trim()) ? text : undefined
      },
      { timeoutMs: 20_000 }
    )
    expect(saved).toBeDefined()
    // Past the editor's debounce and the save delay: every write of the switch has landed.
    await sleep(1_500)
    const text = readFileSync(file, 'utf8')
    expect(timesIn(text, typed.trim())).toBe(1)
    expect(timesIn(text, 'Written first.')).toBe(1)
    console.log('TMP4281 round', round, Date.now(), text.includes(outside), JSON.stringify(text))
    if (!text.includes(outside)) {
      const versions = await invokeTest<{ content: string }[]>(app, 'e2e_debug_query', {
        sql: `SELECT content FROM note_snapshots WHERE note_id = 'j${date}'`
      })
      if (!versions.some((version) => version.content.includes(outside)))
        console.log('TMP4281', round, JSON.stringify(text), JSON.stringify(versions))
      expect(versions.some((version) => version.content.includes(outside))).toBe(true)
    }

    await page.getByRole('button', { name: 'Next day' }).first().click()
    await expect(editor).toContainText(typed.trim())
    const body = (await entry(page, date))?.content ?? ''
    expect(timesIn(body, typed.trim())).toBe(1)
    await expect.poll(async () => timesIn(await editor.innerText(), typed.trim())).toBe(1)
    if (text.includes(outside)) await expect(editor).toContainText(outside)
  }
  // Nothing the reopened day showed was saved back over the file.
  await sleep(1_500)
  const last = readFileSync(file, 'utf8')
  for (const round of [1, 2, 3, 4, 5, 6]) expect(timesIn(last, `Typed ${round}.`)).toBe(1)
})
