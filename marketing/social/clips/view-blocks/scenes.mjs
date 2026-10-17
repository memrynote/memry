// View blocks: under the Meetings heading of the Studio North hub note, /view and the source
// menu's Tag > #meeting list the three meeting notes. Then a new note, Call with Jonas, tagged
// meeting; back in Studio North the list already has it on top, without a reload.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { closeOtherTabs, expandFolder, expandSection, open, settle } from '../../engine/kit.mjs'

const NEW = 'Call with Jonas'

export async function setup({ page }) {
  await open(page, 'Studio North')
  await closeOtherTabs(page, 'Studio North')
  await expandSection(page, 'Collections')
  // Expanded last, so the sidebar's New note files the new note here.
  await expandFolder(page, 'Meetings')
  if (await page.getByRole('button', { name: 'Resize Day Panel' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  const hide = page.getByRole('button', { name: 'Hide suggested tags' })
  if (await hide.count()) await hide.click()
  await settle(page)
}

const heading = (page) => page.getByRole('heading', { name: 'Meetings' })
const row = (page, title) => page.locator('menu [role="button"]').filter({ hasText: title })

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.5)
    const h = await heading(page).boundingBox()
    await rec.glide(h.x + h.width + 200, h.y + 120, 1000)
    await rec.glide(h.x + h.width + 24, h.y + h.height / 2 + 4, 900)
  },
  async insert({ rec, page, zoom, sleep }) {
    const h = await heading(page).boundingBox()
    zoom(h.x + 300, h.y + 120, 1.7)
    await rec.click(heading(page), { dx: h.width / 2 + 20 })
    await sleep(350)
    await rec.key('Enter')
    await sleep(300)
    await rec.type('/view', { cps: 10 })
    await page.getByRole('option', { name: 'View', exact: true }).waitFor()
    await sleep(400)
    await rec.key('Enter')
    await page.getByRole('menuitem', { name: 'Tag' }).waitFor()
    await sleep(300)
    // Around the menu's left side to the Tag row, so the pointer crosses no other item: Folder is
    // a submenu too, and passing over it keeps Tag's submenu shut.
    const t = await rec.center(page.getByRole('menuitem', { name: 'Tag' }))
    await rec.glide(t.x - 160, t.y - 130, 500)
    await rec.glide(t.x - 160, t.y + 2, 500)
  },
  async tag({ rec, page, zoom, sleep }) {
    const t = await rec.center(page.getByRole('menuitem', { name: 'Tag' }))
    await rec.glide(t.x - 20, t.y, 600)
    await page.getByRole('menuitem', { name: '#meeting' }).waitFor()
    await sleep(350)
    await rec.click(page.getByRole('menuitem', { name: '#meeting' }))
    await row(page, 'Studio North Kickoff').waitFor()
    const b = await page.getByTestId('view-block-source').boundingBox()
    zoom(b.x + 320, b.y + 80, 1.7)
    await rec.glide(b.x + 560, b.y + 150, 900)
  },
  async write({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(450)
    await rec.click(page.getByRole('button', { name: /^New note/ }).first())
    await page.getByRole('textbox', { name: 'Rename' }).waitFor()
    zoom(520, 200, 1.6)
    await sleep(500)
    await rec.type(NEW, { cps: 11 })
    await sleep(250)
    await rec.key('Enter')
    await sleep(500)
    const md = page.getByTestId('note-metadata').first()
    const add = md.getByRole('button', { name: 'Add tag', exact: true })
    const a = await add.boundingBox()
    zoom(a.x + 60, a.y + 60, 1.8)
    await rec.click(add)
    await page.getByPlaceholder('Type tag name...').waitFor()
    await sleep(300)
    await rec.type('meeting', { cps: 10 })
    await page.getByRole('option', { name: 'meeting' }).waitFor()
    await sleep(300)
    await rec.key('Enter')
    await sleep(350)
    await rec.key('Escape')
  },
  async live({ rec, page, zoom, unzoom, sleep }) {
    unzoom()
    await sleep(450)
    await rec.click(page.getByRole('button', { name: 'Browser back' }))
    await row(page, NEW).waitFor()
    await sleep(250)
    const b = await page.getByTestId('view-block-source').boundingBox()
    zoom(b.x + 320, b.y + 90, 1.7)
    const r = await row(page, NEW).boundingBox()
    await rec.glide(r.x + 250, r.y + r.height / 2 + 6, 1000)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

const read = (rel) => {
  const { vaultPath } = JSON.parse(
    fs.readFileSync(path.join(process.env.TMPDIR, 'memry-agent-app.json'), 'utf8')
  )
  return fs.readFileSync(path.join(vaultPath, rel), 'utf8')
}

export const checks = [
  [
    'Studio North holds a memry-view block of tag meeting',
    () =>
      /```memry-view[\s\S]*"kind": "tag"[\s\S]*"tag": "meeting"/.test(
        read('Studio North/Studio North.md')
      )
        ? null
        : read('Studio North/Studio North.md')
  ],
  [
    'the new note is a meeting note',
    () =>
      /tags:\n\s+- meeting/.test(read(`Meetings/${NEW}.md`)) ? null : read(`Meetings/${NEW}.md`)
  ]
]
