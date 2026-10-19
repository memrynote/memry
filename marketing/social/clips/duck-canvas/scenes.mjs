// A duck on a canvas, built from the canvas's own shape tools and style panel: an ellipse for the
// body and the head, a beak, an eye, and waves with the pencil. Setup only opens a
// new empty canvas and hides the day panel; every shape and every color on screen is drawn and
// picked on camera.
import { settle } from '../../engine/kit.mjs'

export async function setup({ page }) {
  await page.getByRole('button', { name: 'New canvas' }).first().click()
  await page.locator('.excalidraw').first().waitFor()
  await page.waitForTimeout(1500)
  if (await page.getByRole('tablist', { name: 'Right sidebar' }).count()) {
    await page.keyboard.press('Meta+Shift+b')
    await page.waitForTimeout(700)
  }
  await settle(page, 1100, 700)
}

const tool = (page, name) => page.locator(`.excalidraw label[title^="${name}"]`)
const swatch = (page, hex) => page.locator(`.excalidraw button[title="${hex}"]`).first()

const YELLOW = '#ffec99'
const ORANGE = '#f08c00'
const BLUE = '#1971c2'

/** Pick `name`, then drag out a shape from (x0, y0) to (x1, y1) like a hand would. */
async function draw({ rec, page, sleep }, name, [x0, y0, x1, y1]) {
  await rec.click(tool(page, name), { pause: 90 })
  await sleep(120)
  await rec.glide(x0, y0, 330)
  await sleep(90)
  rec.mark('click')
  await page.mouse.down()
  await rec.glide(x1, y1, 520)
  await sleep(90)
  await page.mouse.up()
  await sleep(300)
}

/** With a shape selected: a stroke and/or background color from the style panel. */
async function paint(ctx, { fill, stroke }) {
  const { rec, page, sleep } = ctx
  if (stroke) {
    await rec.click(swatch(ctx.page, stroke), { pause: 90 })
    await sleep(180)
  }
  if (fill) {
    await rec.click(swatch(page, fill), { pause: 90 })
    await sleep(250)
  }
}

export const scenes = {
  async hook({ rec, page, at }) {
    await at(0.4)
    const c = await rec.center(tool(page, 'Ellipse'))
    await rec.glide(c.x - 220, c.y + 260, 1300)
    await rec.glide(c.x, c.y + 20, 900)
  },
  async body(ctx) {
    ctx.zoom(790, 450, 1.5)
    await ctx.sleep(350)
    await draw(ctx, 'Ellipse', [790, 410, 1080, 550])
    await paint(ctx, { fill: YELLOW })
    await ctx.at(4.4)
  },
  async head(ctx) {
    await draw(ctx, 'Ellipse', [775, 310, 895, 430])
    await paint(ctx, { fill: YELLOW })
    await ctx.sleep(300)
    await draw(ctx, 'Ellipse', [710, 368, 782, 402])
    await paint(ctx, { stroke: ORANGE, fill: YELLOW })
    await ctx.at(6.0)
  },
  async face(ctx) {
    await draw(ctx, 'Ellipse', [818, 345, 834, 361])
    await paint(ctx, { stroke: '#1e1e1e' })
    await ctx.at(4.0)
  },
  async water(ctx) {
    const { rec, page, sleep } = ctx
    await rec.click(tool(page, 'Draw'), { pause: 90 })
    await sleep(250)
    for (const [x0, y0] of [[760, 590]]) {
      await rec.glide(x0, y0, 330)
      await sleep(90)
      rec.mark('click')
      await page.mouse.down()
      for (let i = 1; i <= 22; i++) {
        await page.mouse.move(x0 + i * 12, y0 + Math.sin(i * 0.9) * 10, { steps: 2 })
        await sleep(8)
      }
      await page.mouse.up()
      await sleep(300)
    }
    await sleep(300)
    await rec.click(tool(page, 'Selection'), { pause: 90 })
    await rec.glide(760 + 11 * 12, 590 + Math.sin(11 * 0.9) * 10, 350)
    rec.mark('click')
    await page.mouse.down()
    await page.mouse.up()
    await sleep(300)
    await rec.click(swatch(page, BLUE), { pause: 90 })
    await ctx.at(4.4)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
