/**
 * Clicking a journal reminder must open the day the reminder stores, not today
 * (#2071). The desktop-notification click is the path that was broken, so this
 * drives that exact IPC event and then proves the destination by TYPING into the
 * journal the app landed on: the text has to end up in the target day's file in
 * the vault, and today's file must not have it.
 *
 * The vault file is the assertion on purpose — it is the app's own answer about
 * which entry was open, rather than a rendered date string that could be right
 * for the wrong reason.
 */

import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { navigateTo } from './utils/electron-helpers'
import * as fs from 'fs'
import * as path from 'path'

test.describe('journal reminder navigation', () => {
  test('a due journal reminder opens its own date, not today', async ({
    page,
    electronApp,
    testVaultPath
  }) => {
    await ready(page)
    await navigateTo(page, 'journal')

    // Both dates are computed in the renderer so they are the same local days
    // the app resolves — a UTC-derived key is a different day for half the world.
    const { targetDate, today } = await page.evaluate(() => {
      const key = (date: Date): string =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
          date.getDate()
        ).padStart(2, '0')}`
      const past = new Date()
      past.setDate(past.getDate() - 40)
      return { targetDate: key(past), today: key(new Date()) }
    })

    const reminder = await page.evaluate(async (date) => {
      await window.api.reminders.create({
        targetType: 'journal',
        targetId: date,
        remindAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        title: 'Revisit this day'
      })
      const listed = await window.api.reminders.list({ targetType: 'journal', targetId: date })
      return listed.reminders[0]
    }, targetDate)

    expect(reminder.targetId).toBe(targetDate)

    // The OS notification click, as the main process delivers it.
    await electronApp.evaluate(
      ({ BrowserWindow }, payload) => {
        BrowserWindow.getAllWindows()[0].webContents.send('reminder:clicked', payload)
      },
      { reminder: { ...reminder, targetTitle: targetDate, targetExists: true } }
    )

    const editor = page.locator('.bn-container [contenteditable="true"]').first()
    await editor.waitFor({ state: 'visible', timeout: 15_000 })
    await editor.click()
    await page.keyboard.type('Reminder navigation landed here.')

    const read = (date: string): string => {
      const file = path.join(testVaultPath, 'journal', `${date}.md`)
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    }

    await expect
      .poll(() => read(targetDate), { timeout: 20_000 })
      .toContain('Reminder navigation landed here.')
    expect(read(today)).not.toContain('Reminder navigation landed here.')
  })
})
