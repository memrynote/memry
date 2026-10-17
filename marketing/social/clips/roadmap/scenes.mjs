// memrynote.com/roadmap, live: in progress, then the planned items.

const smoothTo = async ({ page, sleep }, y, steps = 30) => {
  const from = await page.evaluate(() => scrollY)
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    await page.evaluate((v) => scrollTo(0, v), from + (y - from) * e)
    await sleep(16)
  }
}
const item = (page, title) => page.getByText(title, { exact: true }).first()

export async function setup({ page }) {
  await page.mouse.move(800, 720)
  await page.waitForTimeout(600)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.6)
    await rec.glide(760, 560, 1400)
  },
  async now(ctx) {
    const { page, rec, zoom, sleep } = ctx
    await smoothTo(ctx, 300)
    await sleep(250)
    const b = await item(page, 'Native iPhone app, in TestFlight beta').boundingBox()
    zoom(b.x + 380, b.y + 40, 1.7)
    await rec.glide(b.x - 30, b.y + 10, 800)
  },
  async next(ctx) {
    const { page, rec, zoom, unzoom, sleep } = ctx
    unzoom()
    await smoothTo(ctx, 640)
    await sleep(250)
    const b = await item(page, 'Outlook and Microsoft 365 calendars').boundingBox()
    zoom(b.x + 380, b.y + 70, 1.6)
    await rec.glide(b.x - 30, b.y + 95, 800)
  },
  async later(ctx) {
    const { page, rec, zoom, unzoom, sleep } = ctx
    unzoom()
    await smoothTo(ctx, 1130)
    await sleep(250)
    const b = await item(page, 'Plugin API').boundingBox()
    zoom(b.x + 380, b.y + 130, 1.55)
    await rec.glide(b.x - 30, b.y + 175, 800)
  },
  async ask({ unzoom, rec }) {
    unzoom()
    await rec.glide(1250, 700, 900)
  },
  async end() {}
}
