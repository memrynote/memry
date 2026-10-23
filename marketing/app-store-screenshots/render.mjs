// Renders index.html (one 7920x2868 panorama) and slices it into six 1320x2868 App Store
// screenshots (iPhone 6.9"). node render.mjs [--sheet] -> out/*.png
import { chromium } from 'playwright'
import sharp from 'sharp'
import { mkdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const out = path.join(dir, 'out')
const W = 7920,
  H = 2868,
  PW = 1320
const NAMES = ['01-hero', '02-capture', '03-notes', '04-tasks', '05-journal', '06-private']

mkdirSync(out, { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
page.on('pageerror', (e) => console.error('pageerror:', e.message))
page.on('console', (m) => {
  if (m.type() === 'error') console.error('console:', m.text())
})
await page.goto(pathToFileURL(path.join(dir, 'index.html')).href)
await page.evaluate(() => window.ready)
await page.waitForTimeout(300)
const full = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } })
await browser.close()

await sharp(full).png().toFile(path.join(out, 'panorama.png'))
for (let i = 0; i < NAMES.length; i++) {
  // App Store rejects alpha channels: flatten to opaque RGB.
  await sharp(full)
    .extract({ left: i * PW, top: 0, width: PW, height: H })
    .flatten({ background: '#FBF9F5' })
    .removeAlpha()
    .png()
    .toFile(path.join(out, `${NAMES[i]}.png`))
}
// 6.5" display set (1284x2778): same art, scaled to width, 12px trimmed from the bottom.
mkdirSync(path.join(out, '6.5in'), { recursive: true })
for (const n of NAMES) {
  await sharp(path.join(out, `${n}.png`))
    .resize({ width: 1284 })
    .extract({ left: 0, top: 0, width: 1284, height: 2778 })
    .png()
    .toFile(path.join(out, '6.5in', `${n}.png`))
}
if (process.argv.includes('--sheet')) {
  await sharp(full)
    .resize({ width: 2640 })
    .jpeg({ quality: 88 })
    .toFile(path.join(out, 'sheet.jpg'))
}
console.log('->', out)
