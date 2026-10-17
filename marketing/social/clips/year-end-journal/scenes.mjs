// The last journal page of 2026: Thursday, December 31, after a month of entries (vault.mjs),
// with three year-end questions typed as headings and answered. Posted on Dec 31, recorded
// earlier: setup pages the day panel's calendar forward to December off camera, so every date
// on screen is Dec 31, 2026.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, settle } from '../../engine/kit.mjs'

const editor = (page) => page.getByRole('region', { name: 'Note editor' })

export async function setup({ page }) {
  await page.getByRole('button', { name: 'Journal', exact: true }).first().click()
  await page.getByRole('button', { name: 'Next month' }).waitFor()
  for (let i = 0; i < 12; i++) {
    if (await page.getByRole('button', { name: 'Thursday, December 31' }).count()) break
    await page.getByRole('button', { name: 'Next month' }).click()
    await page.waitForTimeout(300)
  }
  await page.getByRole('button', { name: 'Thursday, December 31' }).last().click()
  await page
    .getByRole('heading', { name: 'Thursday, December 31' })
    .or(page.getByText('Thursday, December 31'))
    .first()
    .waitFor()
  await closeOtherTabs(page, 'Journal')
  await page.getByText("New Year's Eve dinner").waitFor()
  await settle(page, 900, 620)
}

/** Type a question as a heading, then its answer, and hold the answer at least 1 s. */
async function qa({ rec, sleep }, question, answer, last = false) {
  await rec.type(`## ${question}`, { cps: 14 })
  await sleep(250)
  await rec.key('Enter')
  await sleep(300)
  await rec.type(answer, { cps: 13 })
  await sleep(1000)
  if (last) return
  await rec.key('Enter')
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const b = await editor(page).boundingBox()
    await rec.glide(b.x + 260, b.y + 60, 2200)
  },
  async date({ rec, page, zoom, sleep, at }) {
    zoom(700, 190, 1.8)
    await sleep(600)
    const b = await editor(page).boundingBox()
    await rec.click(editor(page), { dx: -b.width / 2 + 120, pause: 150 })
    await sleep(300)
    // Out of the way of the text, in the right margin.
    await rec.glide(1190, 250, 700)
    await at(3.1)
  },
  async finish(ctx) {
    ctx.zoom(794, 300, 1.8)
    await qa(ctx, 'What did I finish?', 'The Studio North site. Lisbon.')
  },
  async drop(ctx) {
    await qa(ctx, 'What did I drop?', 'Saying yes to everything.')
  },
  async keep(ctx) {
    await qa(ctx, 'What do I want to keep doing?', 'Long walks. This journal.', true)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'journal/2026-12-31.md holds the three questions as headings',
    () => {
      // The running app's vault copy (agent-app's state file, in the slot's TMPDIR).
      const { vaultPath } = JSON.parse(
        fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
      )
      const file = fs.readFileSync(path.join(vaultPath, 'journal/2026-12-31.md'), 'utf8')
      const missing = [
        '## What did I finish?',
        '## What did I drop?',
        '## What do I want to keep doing?'
      ].filter((h) => !file.includes(h))
      return missing.length ? `missing: ${missing.join(', ')}\n${file}` : null
    }
  ]
]
