// A gratitude template: the Gratitude note (eight lines, vault.mjs) sits open; the "Daily page"
// template, opened from Settings → Editor, holds {{random-line:Gratitude}}. The journal's next
// two days, never opened before, are seeded from it the moment they open, each with one line
// picked from Gratitude. The picked line is random, so the checks only read that it came from
// the note.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { day } from '../../vault/cli.mjs'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const nav = (page, name) =>
  page.getByRole('navigation', { name: 'Sections' }).getByRole('button', { name, exact: true })

const vault = () =>
  JSON.parse(fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8'))
    .vaultPath
const journalText = (d) => fs.readFileSync(path.join(vault(), 'journal', `${d}.md`), 'utf8')

export async function setup({ page }) {
  await open(page, 'Gratitude')
  await page.getByText('Morning light on my desk').first().waitFor()
  await closeOtherTabs(page, 'Gratitude')
  await settle(page, 1000, 520)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(page.getByText('Morning light on my desk').first())
    await rec.glide(c.x + 200, c.y, 1200)
    await rec.glide(c.x + 60, c.y + 150, 800)
  },
  async template({ rec, page, zoom, unzoom: _unzoom, sleep, at }) {
    await rec.click(page.getByRole('button', { name: 'Settings', exact: true }), { pause: 150 })
    await rec.click(page.getByText('Editor', { exact: true }).first(), { pause: 150 })
    const row = page.getByText('Daily page', { exact: true }).first()
    await row.waitFor()
    await row.scrollIntoViewIfNeeded()
    await sleep(500)
    await rec.click(row, { pause: 150 })
    const token = page.getByText('{{random-line:Gratitude}}').first()
    await token.waitFor()
    await sleep(500)
    const c = await rec.center(token)
    zoom(c.x, c.y - 20, 1.8)
    await rec.glide(c.x + 120, c.y + 30, 900)
    await at(5.8)
  },
  async next({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await rec.click(nav(page, 'Journal'), { pause: 150 })
    await page.getByRole('button', { name: 'Next day' }).waitFor()
    await rec.click(page.getByRole('button', { name: 'Next day' }), { pause: 150 })
    const h = page.getByRole('heading', { name: 'Grateful for' })
    await h.waitFor()
    await sleep(500)
    const c = await rec.center(h)
    zoom(c.x + 150, c.y + 30, 1.7)
    await rec.glide(c.x + 220, c.y + 70, 900)
  },
  async again({ rec, page, sleep }) {
    await rec.click(page.getByRole('button', { name: 'Next day' }), { pause: 150 })
    await page.getByText('Wednesday, October 21').first().waitFor()
    await sleep(1500)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the next two days were seeded with a line from Gratitude',
    () => {
      const lines = fs
        .readFileSync(path.join(vault(), 'Gratitude.md'), 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .map((l) => l.slice(2))
      for (const d of [day(1), day(2)]) {
        let text
        try {
          text = journalText(d)
        } catch {
          return `no page for ${d}`
        }
        if (!lines.some((l) => text.includes(l))) return `${d}: ${JSON.stringify(text)}`
      }
      return null
    }
  ]
]
