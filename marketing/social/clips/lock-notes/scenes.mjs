// Lock a note: the kickoff notes get their last line, then Lock note from the ⋯ menu. The
// notice "Locked. Read-only for you and for agents." appears and the title greys out; typing the
// same way as before now changes nothing. The checks read the file: the last line is saved, the
// second one never arrives.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const LAST = 'Next: moodboard and a sitemap draft.'
const SIGNED = 'Signed off by Jonas.'
const TRY = ' Maybe one more page'

export async function setup({ page }) {
  await open(page, 'Studio North Kickoff')
  await closeOtherTabs(page, 'Studio North Kickoff')
  await expandSection(page, 'Collections')
  await expandFolder(page, 'Studio North')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  await settle(page)
}

const more = (page) => page.getByTestId('note-more-menu').first()

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const b = await page.getByText(LAST).boundingBox()
    await rec.glide(b.x + b.width + 150, b.y + 90, 1000)
    await rec.glide(b.x + b.width + 30, b.y + b.height / 2 + 4, 900)
  },
  async finish({ rec, page, zoom, sleep }) {
    zoom(800, 450, 1.7)
    const b = await page.getByText(LAST).boundingBox()
    await rec.click(page.getByText(LAST), { dx: b.width / 2 + 24 })
    await sleep(400)
    await rec.key('Enter')
    await sleep(250)
    await rec.type(SIGNED, { cps: 11 })
    await sleep(300)
    await rec.glide(b.x + b.width + 120, b.y + 80, 700)
  },
  async lock({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(500)
    zoom(1300, 330, 1.5)
    await rec.click(more(page))
    const item = page.getByRole('option', { name: 'Lock note' })
    await item.waitFor()
    // The item sits near the bottom of a long menu; follow it down, clear of the caption.
    zoom(1300, 470, 1.6)
    await sleep(800)
    await rec.click(item)
    await page.getByTestId('note-locked-indicator').waitFor()
    // Pull back at once: the change is at the top of the note, the greyed title and the notice.
    unzoom()
    await sleep(300)
    const n = await page.getByTestId('note-locked-indicator').boundingBox()
    await rec.glide(n.x + n.width / 2 + 60, n.y + 70, 1000)
  },
  async locked({ rec, page, zoom }) {
    const n = await page.getByTestId('note-locked-indicator').boundingBox()
    zoom(n.x + 200, n.y + 110, 1.8)
    await rec.glide(n.x + n.width / 2 + 20, n.y + 50, 1000)
  },
  async type({ rec, page, zoom, sleep }) {
    const s = await page.getByText(SIGNED).boundingBox()
    zoom(s.x + 230, s.y - 90, 1.9)
    await sleep(500)
    const b = await page.getByText(SIGNED).boundingBox()
    await rec.click(page.getByText(SIGNED), { dx: b.width / 2 + 24 })
    await sleep(400)
    await rec.type(TRY, { cps: 11 })
    await sleep(300)
    await rec.glide(b.x + b.width + 120, b.y + 70, 800)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const file = () => {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, 'Studio North/Studio North Kickoff.md'), 'utf8')
}

export const checks = [
  ['the last line was saved before the lock', () => (file().includes(SIGNED) ? null : file())],
  [
    'nothing typed after the lock reached the file',
    () => (file().includes(TRY.trim()) ? file() : null)
  ],
  [
    'the note is locked',
    (query) =>
      query("SELECT locked FROM vault_locks WHERE target_kind = 'note'").some((r) => r.locked)
        ? null
        : 'no note lock row'
  ]
]
