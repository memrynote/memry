// An mp4 attached to a note plays inline. /video opens the attachment picker; Upload media… takes
// the file (the browser file chooser is answered with the asset, off the app's UI: the OS dialog
// is not filmable), and the note shows a player with controls.
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { vaultFile } from '../graph-edit/ui.mjs'
import { closeOtherTabs, open, settle } from '../../engine/kit.mjs'

const VIDEO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../vault/assets/video-attach-alfama.mp4'
)
const NOTE = 'Alfama walk'
const para = (page) => page.locator('.bn-block-content').filter({ hasText: 'Sunday morning' })

/** Screen point just past the last character of a block (a click there puts the caret at its end). */
const textEnd = (locator) =>
  locator.evaluate((el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = range.getClientRects()
    const last = rects[rects.length - 1]
    return { x: last.right + 12, y: last.top + last.height / 2 }
  })

export async function setup({ page }) {
  await open(page, NOTE)
  await closeOtherTabs(page, NOTE)
  await page.waitForTimeout(2500)
  await settle(page, 1100, 650)
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.6)
    const end = await textEnd(para(page))
    await rec.glide(end.x, end.y, 1800)
  },
  async slash({ rec, page, zoom, sleep, at }) {
    zoom(800, 300, 1.7)
    const end = await textEnd(para(page))
    await rec.glide(end.x, end.y, 200)
    rec.mark('click')
    await page.mouse.click(end.x, end.y)
    await sleep(350)
    await rec.key('Enter')
    await rec.type('/video', { cps: 9 })
    await page.getByText('Video', { exact: true }).first().waitFor()
    await sleep(700)
    await rec.key('Enter')
    await page.getByText('Upload media…').waitFor()
    await at(4.4)
  },
  async pick({ rec, page, sleep, at }) {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser'),
      rec.click(page.getByText('Upload media…'))
    ])
    await sleep(500)
    await chooser.setFiles(VIDEO)
    await page.locator('video[data-testid="video-embed"]').waitFor()
    await at(4.2)
  },
  async play({ rec, page, zoom, sleep, at }) {
    const v = page.locator('video[data-testid="video-embed"]')
    // Lift the player clear of the caption band, then zoom on it.
    await rec.glide(1100, 500, 300)
    for (let i = 0; i < 12; i++) {
      await page.mouse.wheel(0, 20)
      await sleep(40)
    }
    await sleep(300)
    await sleep(500)
    const b = await v.boundingBox()
    zoom(b.x + b.width / 2, b.y + b.height / 2 - 20, 1.5)
    await sleep(600)
    await rec.glide(b.x + b.width / 2, b.y + b.height / 2 - 40, 900)
    await sleep(300)
    rec.mark('click')
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2 - 40)
    await page
      .waitForFunction(() => document.querySelector('video')?.currentTime > 0.8, null, {
        timeout: 5000
      })
      .catch(async () => {
        await page.screenshot({ path: '/tmp/vadbg.png' })
        throw new Error(
          JSON.stringify(
            await page.evaluate(() => {
              const v = document.querySelector('video')
              return [v.currentTime, v.paused, v.readyState, v.error?.message]
            })
          ) + JSON.stringify(b)
        )
      })
    await rec.glide(b.x + b.width / 2 + 160, b.y + 60, 800)
    await at(5.8)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

export const checks = [
  [
    'the note file references the mp4',
    () => (vaultFile(`Lisbon/${NOTE}.md`).includes('.mp4') ? null : 'no mp4 in the note')
  ]
]
