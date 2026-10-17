// memrynote on iPhone: the six App Store screenshots (marketing/app-store-screenshots) in one calm
// pan. The page pans the strip; the compositor holds one zoom over it, so each step's screenshot
// crosses the frame while its caption shows.
//
// A busy machine screencasts the page at about 15 fps, and a pan at 15 fps judders. So the page
// clock runs SLOW times slower than real time and the take plays back SLOW times faster
// (rec.speed): 45 fps of film. Every time here, and every `dur` in narration.json, is film time.
import * as fs from 'node:fs'

const SLOW = 3
const OUT = new URL('../../../app-store-screenshots/out/', import.meta.url)
const N = JSON.parse(fs.readFileSync(new URL('narration.json', import.meta.url), 'utf8'))

// Starts 2 s into the hook and ends with the last step. Checked against the crop below: each
// step's screenshot stays whole inside it for at least 97% of the step.
const PAN = { v: 88, rampIn: 4.0, rampOut: 3.0, total: 22.0 }
// The crop's centre: x = 700 rather than the middle, because the pan moves right to left and the
// next screenshot should enter while the current one is still whole.
const ZOOM = [700, 380, 1.5]

export async function setup({ page }) {
  if (!fs.existsSync(new URL('06-private.png', OUT)))
    throw new Error(
      'No App Store screenshots. Run: node marketing/app-store-screenshots/render.mjs'
    )
  await page.addStyleTag({ content: '#__tut_cursor { display: none }' })
  await page.evaluate((slow) => {
    window.SLOW = slow
    return window.ready
  }, SLOW)
}

const steps = {
  async hook({ page, at }) {
    await at(2.0)
    await page.evaluate((plan) => window.strip.pan(plan), PAN)
  },
  async capture({ zoom }) {
    zoom(...ZOOM)
  },
  async end({ unzoom }) {
    unzoom()
  }
}

// Each scene in film time: `at` and `sleep` scaled by SLOW, and the scene held for its `dur`.
export const scenes = Object.fromEntries(
  N.scenes.map(({ id, dur }, i) => [
    id,
    async (ctx) => {
      if (i === 0) ctx.rec.speed(SLOW)
      const at = (s) => ctx.at(s * SLOW)
      await steps[id]?.({ ...ctx, at, sleep: (ms) => ctx.sleep(ms * SLOW) })
      await at(dur)
    }
  ])
)
