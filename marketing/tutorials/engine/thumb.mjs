#!/usr/bin/env node
// YouTube thumbnails from the film's own frames: thumb.html rendered at 1280x720 CSS px and 3x,
// so 3840x2160 JPEGs (YouTube's recommended size), one per `thumbnails` variant in
// narration.json, written as out/<topic>.thumb-<n>.jpg. out/<topic>.thumbs.png shows each one at
// the widths YouTube draws it: 640, 320 (home and search) and 168 px (phone lists), and the
// first one beside the other topics' first thumbnails, as a phone list would show them.
//
//   node marketing/tutorials/engine/thumb.mjs <topic>
//
// A variant: { text, highlight, label?, shot: { scene, at?, x, y, w } }. `at` is seconds into the
// scene's line (default: its last fifth); x, y, w are the crop's center and width in the
// recorder's CSS px (1600x900), the coordinates scenes.mjs uses.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const url = (p) => pathToFileURL(p).href

/** The recorded frame on screen `at` seconds into a scene's line. */
function frameAt(dir, scene, at) {
  const take = path.join(dir, 'out/take')
  const s = JSON.parse(fs.readFileSync(path.join(take, 'timeline.json'), 'utf8')).find(
    (x) => x.id === scene
  )
  if (!s) throw new Error(`No scene "${scene}" in ${take}/timeline.json. Run the build first.`)
  const t = s.vo + (at ?? s.dur * 0.8)
  const frames = JSON.parse(fs.readFileSync(path.join(take, 'frames.json'), 'utf8'))
  return frames.findLast((f) => f.t <= t).f
}

export async function renderThumbs(dir) {
  const topic = path.basename(dir)
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  if (!N.thumbnails?.length) throw new Error(`${dir}/narration.json has no "thumbnails"`)
  const out = path.join(dir, 'out')
  // A variant removed from narration.json must not leave its old file behind to be uploaded.
  for (const f of fs.readdirSync(out))
    if (f.startsWith(`${topic}.thumb-`)) fs.rmSync(path.join(out, f))

  const browser = await chromium.launch()
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 3
  })
  await page.goto(url(path.join(ENGINE, 'thumb.html')))
  const files = []
  for (const [i, v] of N.thumbnails.entries()) {
    await page.evaluate((P) => window.draw(P), {
      text: v.text,
      highlight: v.highlight,
      label: v.label ?? N.card?.label ?? 'Tutorial',
      frame: url(frameAt(dir, v.shot.scene, v.shot.at)),
      crop: v.shot
    })
    const file = path.join(out, `${topic}.thumb-${i + 1}.jpg`)
    await page.screenshot({ path: file, type: 'jpeg', quality: 90 })
    files.push(file)
  }

  const root = path.dirname(dir)
  const others = fs
    .readdirSync(root)
    .filter((t) => t !== topic)
    .map((t) => path.join(root, t, `out/${t}.thumb-1.jpg`))
    .filter((f) => fs.existsSync(f))
  const img = (f, w) => `<img src="${url(f)}" width="${w}" height="${(w * 9) / 16}">`
  const row = (name, imgs) => `<div class="row"><b>${name}</b>${imgs.join('')}</div>`
  const rows = files.map((f, i) => row(i + 1, [img(f, 640), img(f, 320), img(f, 168)]))
  const phoneList = [files[0], ...others].map((f) => img(f, 168))
  if (others.length) rows.push(row('channel', phoneList))
  const sheet = path.join(out, `${topic}.thumbs.html`)
  fs.writeFileSync(
    sheet,
    `<style>body{margin:0;padding:16px;background:#fff;font:14px system-ui}` +
      `.row{display:flex;flex-wrap:wrap;align-items:flex-start;gap:16px;margin-bottom:16px}` +
      `b{width:64px}img{border-radius:8px}</style>${rows.join('')}`
  )
  const sheetPage = await browser.newPage({ viewport: { width: 1300, height: 400 } })
  await sheetPage.goto(url(sheet))
  await sheetPage.screenshot({ path: path.join(out, `${topic}.thumbs.png`), fullPage: true })
  fs.rmSync(sheet)
  await browser.close()
  return files
}

if (process.argv[1] && import.meta.url === url(process.argv[1])) {
  const dir = process.argv[2] && path.resolve(path.dirname(ENGINE), process.argv[2])
  if (!dir || !fs.existsSync(path.join(dir, 'narration.json')))
    throw new Error('Usage: thumb.mjs <topic>')
  const files = await renderThumbs(dir)
  console.log(
    `  ${files.length} thumbnails and ${path.basename(dir)}.thumbs.png in ${path.dirname(files[0])}`
  )
}
