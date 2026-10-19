// Not now: in the Inbox, "Ask Lea for the brand fonts" is snoozed from its quick actions with
// Pick Date & Time, to the same weekday next week; it leaves the list and the toolbar's snoozed
// count turns to 1. Then Lisbon Itinerary gets a reminder from its toolbar: tomorrow, with a note.
// The dates come from today, so nothing is hard-coded.
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const ITEM = 'Ask Lea for the brand fonts'
const WEEK = new Date(Date.now() + 7 * 864e5).getDate()
const row = (page) => page.getByRole('listitem', { name: new RegExp(ITEM) })

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Inbox', exact: true }).first().click()
  await row(page).waitFor()
  await closeOtherTabs(page, 'Inbox')
  await page.getByRole('button', { name: 'Search or jump to…' }).waitFor()
  await settle(page, 900, 500)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(row(page))
    await rec.glide(c.x + 100, c.y - 40, 1200)
    await rec.glide(c.x + 330, c.y, 900)
  },
  async snooze({ rec, page, zoom, unzoom, sleep, at }) {
    const c = await rec.center(row(page))
    zoom(c.x + 110, c.y + 90, 1.5)
    await rec.glide(c.x + 400, c.y, 500)
    await rec.click(row(page).getByRole('button', { name: 'Snooze' }), { pause: 150 })
    const pick = page.getByText('Pick Date & Time')
    await pick.waitFor()
    await sleep(500)
    await rec.click(pick, { pause: 150 })
    const dlg = page.getByRole('dialog')
    await dlg.waitFor()
    await sleep(400)
    unzoom()
    await rec.click(
      dlg
        .getByRole('gridcell', { name: String(WEEK), exact: true })
        .locator('button')
        .or(dlg.getByText(String(WEEK), { exact: true }))
        .last(),
      {
        pause: 150
      }
    )
    await sleep(700)
    await rec.click(dlg.getByRole('button', { name: 'Snooze', exact: true }), { pause: 150 })
    await dlg.waitFor({ state: 'hidden' })
    await at(6.2)
  },
  async gone({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(500)
    await row(page).waitFor({ state: 'detached' })
    const chip = page.getByRole('button', { name: '1', exact: true }).first()
    const c = await rec.center(chip)
    zoom(c.x - 300, c.y + 100, 1.6)
    await rec.glide(c.x - 6, c.y + 12, 900)
  },
  async remind({ rec, page, zoom, unzoom, sleep, at }) {
    unzoom()
    await sleep(400)
    await open(page, 'Lisbon Itinerary')
    await page.getByRole('button', { name: 'Set reminder' }).waitFor()
    const b = page.getByRole('button', { name: 'Set reminder' })
    const c = await rec.center(b)
    zoom(c.x - 150, c.y + 140, 1.6)
    await rec.click(b, { pause: 150 })
    const tomorrow = page.getByText('Tomorrow', { exact: true })
    await tomorrow.waitFor()
    await sleep(500)
    const note = page.getByPlaceholder('Add a note (optional)')
    await rec.click(note, { pause: 120 })
    await rec.type('Book the Sintra train', { cps: 11 })
    await sleep(400)
    await rec.click(tomorrow, { pause: 150 })
    await page.getByText('Reminder set', { exact: true }).first().waitFor()
    await sleep(500)
    // The toast confirms it and the bell turns to "reminder set"; the cursor rests on the bell.
    await rec.glide(c.x, c.y + 4, 700)
    await at(6.2)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'one inbox item is snoozed, and Lisbon Itinerary has a reminder',
    (query) => {
      const s = query('SELECT snoozed_until FROM inbox_items WHERE snoozed_until IS NOT NULL')
      const r = query("SELECT note FROM reminders WHERE note = 'Book the Sintra train'")
      return s.length === 1 && r.length === 1 ? null : JSON.stringify({ s, r })
    }
  ]
]
