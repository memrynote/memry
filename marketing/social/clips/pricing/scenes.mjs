// memrynote.com/pricing, live: the free plan, then monthly prices, then all four plans.

const smoothTo = async ({ page, sleep }, y, steps = 26) => {
  const from = await page.evaluate(() => scrollY)
  for (let i = 1; i <= steps; i++) {
    const k = i / steps
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2
    await page.evaluate(
      (v) => {
        scrollTo(0, v)
      },
      from + (y - from) * e
    )
    await sleep(16)
  }
}

export async function setup({ page }) {
  await page.mouse.move(800, 700)
  await page.waitForTimeout(600)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.6)
    await rec.glide(800, 520, 1400)
  },
  async free(ctx) {
    const { page, zoom, sleep } = ctx
    await smoothTo(ctx, 360)
    await sleep(300)
    const b = await page.getByText('$0', { exact: true }).first().boundingBox()
    zoom(b.x + 120, b.y - 20, 1.9)
  },
  async monthly(ctx) {
    const { rec, page, zoom, unzoom, sleep } = ctx
    unzoom()
    await sleep(400)
    await rec.click(page.getByRole('tab', { name: /monthly/i }))
    await sleep(700)
    const b = await page.getByText('Plus', { exact: true }).first().boundingBox()
    zoom(b.x + 180, b.y + 80, 1.8)
  },
  async same({ rec, unzoom }) {
    unzoom()
    await rec.glide(1250, 760, 900)
  },
  async end() {
    /* intentional no-op */
  }
}
