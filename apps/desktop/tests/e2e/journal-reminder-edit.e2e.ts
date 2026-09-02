/**
 * A journal entry carries one reminder. Picking a custom time after a preset
 * used to append a second row (#1939), and nothing in the journal picker could
 * remove either one. This drives the real picker: preset, then custom time,
 * then remove, reading the reminder rows back over the same IPC surface the app
 * uses so the count is the app's own answer and not a rendering artifact.
 */

import type { Page } from '@playwright/test'
import { test, expect } from './fixtures'
import { ready } from './utils/desktop-test-helpers'
import { navigateTo } from './utils/electron-helpers'

interface JournalReminderRow {
  id: string
  targetId: string
  remindAt: string
  status: string
}

async function journalReminders(page: Page): Promise<JournalReminderRow[]> {
  return page.evaluate(async () => {
    const result = await window.api.reminders.list({ targetType: 'journal' })
    return result.reminders.map((reminder) => ({
      id: reminder.id,
      targetId: reminder.targetId,
      remindAt: reminder.remindAt,
      status: reminder.status
    }))
  })
}

/** Local parts of an ISO instant, read in the renderer so the zone matches. */
async function localParts(
  page: Page,
  iso: string
): Promise<{ year: number; month: number; day: number; hours: number; minutes: number }> {
  return page.evaluate((value) => {
    const date = new Date(value)
    return {
      year: date.getFullYear(),
      month: date.getMonth(),
      day: date.getDate(),
      hours: date.getHours(),
      minutes: date.getMinutes()
    }
  }, iso)
}

test.describe('journal reminder edit and remove', () => {
  test('a custom time replaces the preset reminder, and removing it clears the bell', async ({
    page
  }) => {
    await ready(page)
    await navigateTo(page, 'journal')

    const editor = page.locator('.bn-container [contenteditable="true"]').first()
    await editor.waitFor({ state: 'visible', timeout: 15_000 })
    await editor.click()
    await page.keyboard.type('Reminder replacement check.')

    const unsetBell = page.getByRole('button', { name: 'Set reminder to revisit' })
    await expect(unsetBell).toBeVisible({ timeout: 15_000 })
    await unsetBell.click()

    const picker = page.locator('[data-slot="picker-content"]')
    await expect(picker).toBeVisible()
    await picker.getByRole('option', { name: /In 1 Week/i }).click()

    await expect.poll(async () => (await journalReminders(page)).length).toBe(1)
    const [preset] = await journalReminders(page)
    expect(preset.status).toBe('pending')

    const setBell = page.getByRole('button', { name: /^Reminder:/ })
    await expect(setBell).toBeVisible()
    await setBell.click()
    await expect(picker).toBeVisible()

    // The entry already has a reminder, so the picker lists it with its own
    // remove button rather than only offering to set another.
    await expect(picker.getByRole('button', { name: 'Delete reminder' })).toHaveCount(1)

    await picker.getByRole('option', { name: /Pick date/i }).click()
    await picker.getByRole('button', { name: 'Next month' }).click()
    // The 15th of next month is always in the future and appears once in the
    // grid; the surrounding out-of-month days are only ever month edges.
    await picker.getByRole('button', { name: / 15$/ }).click()
    await picker.locator('#reminder-time').fill('18:45')
    await picker.getByRole('button', { name: 'Set reminder' }).click()

    await expect
      .poll(async () => (await journalReminders(page)).map((row) => row.remindAt))
      .toHaveLength(1)

    const [replaced] = await journalReminders(page)
    expect(replaced.id).toBe(preset.id)
    expect(replaced.targetId).toBe(preset.targetId)
    expect(replaced.remindAt).not.toBe(preset.remindAt)

    const moved = await localParts(page, replaced.remindAt)
    const expected = await page.evaluate(() => {
      const now = new Date()
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 15)
      return { year: next.getFullYear(), month: next.getMonth(), day: 15 }
    })
    expect(moved).toMatchObject({ ...expected, hours: 18, minutes: 45 })

    await page.getByRole('button', { name: /^Reminder:/ }).click()
    await expect(picker).toBeVisible()
    await picker.getByRole('button', { name: 'Delete reminder' }).click()

    await expect.poll(async () => (await journalReminders(page)).length).toBe(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: 'Set reminder to revisit' })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Reminder:/ })).toHaveCount(0)
  })
})
