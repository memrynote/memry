// github.com/memrynote/memry, live: the license, the crypto module, the protocol docs.

const visible = (l) => l.filter({ visible: true }).first()
// GitHub names folder links "crates, (Directory)" and file links "sodium.rs, (File)".
const link = (page, name) =>
  visible(
    page.getByRole('link', {
      name: new RegExp(`^${name.replace('.', '\\.')}(, \\((Directory|File)\\))?$`)
    })
  )
async function go({ rec, page, sleep }, name) {
  const l = link(page, name)
  await l.scrollIntoViewIfNeeded()
  await rec.click(l)
  await page.waitForLoadState('domcontentloaded')
  await sleep(450)
}

export async function setup({ page }) {
  await page.mouse.move(700, 700)
  await page.waitForTimeout(800)
}

export const scenes = {
  async hook({ rec, at }) {
    await at(0.6)
    await rec.glide(1250, 300, 1400)
  },
  async license({ page, rec, zoom }) {
    // The About sidebar's license link (the README's license tab is further down the page).
    const all = page.getByText('AGPL-3.0 license', { exact: true })
    let b
    for (let i = 0; i < (await all.count()); i++) {
      const x = await all.nth(i).boundingBox()
      if (x && x.width && x.y > 0 && x.y < 900) b = x
    }
    zoom(b.x + 60, b.y - 40, 1.9)
    await rec.glide(b.x + b.width / 2, b.y + b.height / 2, 900)
  },
  async crypto(ctx) {
    const { page, zoom, unzoom, sleep } = ctx
    unzoom()
    await sleep(300)
    for (const name of ['crates', 'memry-core', 'src', 'crypto']) await go(ctx, name)
    const b = await link(page, 'sodium.rs').boundingBox()
    zoom(b.x + 260, b.y - 40, 1.7)
  },
  async protocol(ctx) {
    const { page, zoom, unzoom, sleep } = ctx
    unzoom()
    await sleep(200)
    await page.goto('https://github.com/memrynote/memry/tree/main/docs/protocol', {
      waitUntil: 'domcontentloaded'
    })
    await sleep(700)
    const b = await link(page, '04-record-envelope.md').boundingBox()
    zoom(b.x + 280, b.y, 1.55)
  },
  async end({ unzoom }) {
    unzoom()
  }
}
