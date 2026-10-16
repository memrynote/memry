// YouTube thumbnails from the film's own frames: thumb.html, the channel's template, rendered at
// 1280x720 CSS px and 3x, so 3840x2160 JPEGs (YouTube's recommended size), one per `thumbnails`
// variant in narration.json, written as out/<topic>.thumb-<n>.jpg. out/<topic>.thumbs.png shows
// each one at the widths YouTube draws it: 640, 320 (home and search) and 168 px (phone lists),
// and the first one beside the other topics' first thumbnails, as a phone list would show them.
//
//   node marketing/tutorials/engine/build.mjs <topic> --only youtube
//
// A variant: { text, shot: { scene, at?, x, y, w, h } }.
// - text: one or two lines (\n), at most four words, with one orange mark: a single →, drawn as
//   the orange arrow, or without one the final . ? or !
// - shot: `at` is seconds into the scene's line (default: its last fifth); x, y, w, h are the
//   crop's center and size in the recorder's CSS px (1600x900), the coordinates scenes.mjs uses.
//   The card keeps the crop's shape inside a 500x469 box at the right margin, so a crop near
//   square (a column, a panel, a menu) gives the biggest card. Below about 15% of the frame a
//   subject turns to texture at 168 px (Thumblore's 2026 trends guide), and the CLI warns.
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

/** What in variant i breaks the template, as `thumbnails[i].field: why` lines. */
function check(v, i) {
  const at = `thumbnails[${i}]`
  const errors = []
  const text = v.text ?? ''
  const lines = text.split('\n').length
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length
  const arrows = text.split('→').length - 1
  if (lines > 2) errors.push(`${at}.text: ${lines} lines, and the template holds 2`)
  if (words > 4) errors.push(`${at}.text: ${words} words; 4 is the most that reads at 168 px`)
  if (arrows > 1 || (!arrows && !/[.?!]$/.test(text)))
    errors.push(`${at}.text: needs one orange mark, a single → or a final . ? or !`)
  const { x, y, w, h } = v.shot ?? {}
  const inside = x - w / 2 >= 0 && y - h / 2 >= 0 && x + w / 2 <= 1600 && y + h / 2 <= 900
  if (![x, y, w, h].every((n) => n > 0) || !inside)
    errors.push(`${at}.shot: x, y, w, h must give a crop inside the 1600x900 recording`)
  return errors
}

export async function renderThumbs(dir) {
  const topic = path.basename(dir)
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  if (!N.thumbnails?.length) throw new Error(`${dir}/narration.json has no "thumbnails"`)
  const errors = N.thumbnails.flatMap(check)
  if (errors.length)
    throw new Error(`${topic} thumbnails break the template:\n  ${errors.join('\n  ')}`)
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
  const warnings = []
  for (const [i, v] of N.thumbnails.entries()) {
    const { overflow, cover } = await page.evaluate((P) => window.draw(P), {
      text: v.text,
      frame: url(frameAt(dir, v.shot.scene, v.shot.at)),
      crop: v.shot
    })
    if (overflow) throw new Error(`${topic} thumbnails[${i}].text "${v.text}": ${overflow}`)
    if (cover < 0.15)
      warnings.push(
        `thumbnails[${i}].shot: the card covers ${Math.round(cover * 100)}% of the frame and reads as texture at 168 px; crop nearer square`
      )
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
  return { files, warnings }
}
