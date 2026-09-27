// Frame renderer for index.html.
//   node render.mjs --stills 0,1.5,6.2          -> PNG stills in /tmp/memry-film/stills
//   node render.mjs --events                     -> events.json (cue list the score reads)
//   node render.mjs --out video.mp4 [--sub 6] [--workers 10] [--scale 1] [--from 0 --to 30]
// Motion blur: each output frame averages samples across a 180-degree shutter; fast frames get more
// (window.samplesAt in index.html), `--sub N` forces a fixed count.
import { chromium } from 'playwright'
import sharp from 'sharp'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}
const has = (k) => argv.includes('--' + k)
const FPS = 60,
  DUR = 30,
  W = 1920,
  H = 1080
const url = pathToFileURL(path.join(dir, 'index.html')).href

async function openPage(browser, scale = 1) {
  const page = await browser.newPage({
    viewport: { width: W, height: H },
    deviceScaleFactor: scale
  })
  page.on('pageerror', (e) => console.error('pageerror:', e.message))
  page.on('console', (m) => {
    if (m.type() === 'error') console.error('console:', m.text())
  })
  await page.goto(url)
  await page.evaluate(() => window.ready)
  const cdp = await page.context().newCDPSession(page)
  return { page, cdp }
}
async function grab(cdp, format = 'jpeg') {
  const r = await cdp.send('Page.captureScreenshot', {
    format,
    quality: format === 'jpeg' ? 96 : undefined,
    optimizeForSpeed: true
  })
  return Buffer.from(r.data, 'base64')
}

if (has('stills') || has('events')) {
  const browser = await chromium.launch()
  const { page, cdp } = await openPage(browser)
  if (has('events')) {
    const ev = await page.evaluate(() => window.EVENTS)
    writeFileSync(path.join(dir, 'events.json'), JSON.stringify(ev, null, 1))
    console.log('events', ev.length)
  }
  if (has('stills')) {
    const out = arg('dir', '/tmp/memry-film/stills')
    mkdirSync(out, { recursive: true })
    for (const t of arg('stills').split(',')) {
      await page.evaluate((x) => window.render(x), +t)
      writeFileSync(
        path.join(out, `s_${(+t).toFixed(2).padStart(5, '0')}.png`),
        await grab(cdp, 'png')
      )
    }
    console.log('stills ->', out)
  }
  await browser.close()
  process.exit(0)
}

// ---------------- full render ----------------
const SUB = arg('sub') ? +arg('sub') : 0,
  WORKERS = +arg('workers', 10)
const f0 = Math.round(+arg('from', 0) * FPS),
  f1 = Math.round(+arg('to', DUR) * FPS)
const out = path.resolve(arg('out', path.join(dir, 'video.mp4')))
const SHUTTER = 0.5
const ff = spawn(
  'ffmpeg',
  [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    '-s',
    `${W}x${H}`,
    '-r',
    String(FPS),
    '-i',
    '-',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    arg('crf', '12'),
    '-tune',
    'animation',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-movflags',
    '+faststart',
    out
  ],
  { stdio: ['pipe', 'inherit', 'inherit'] }
)

const pending = new Map()
let next = f0
async function flush() {
  while (pending.has(next)) {
    const buf = pending.get(next)
    pending.delete(next)
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    next++
  }
}
const started = Date.now()
async function worker(w) {
  const browser = await chromium.launch()
  const { page, cdp } = await openPage(browser)
  // the first captures after load can carry a stray compositor glyph: warm up and discard
  for (let k = 0; k < 2; k++) {
    await page.evaluate(() => window.render(0.5, 30))
    await grab(cdp)
  }
  const acc = new Uint16Array(W * H * 3)
  for (let f = f0 + w; f < f1; f += WORKERS) {
    acc.fill(0)
    const sub = SUB || (await page.evaluate((x) => window.samplesAt(x), f / FPS))
    for (let j = 0; j < sub; j++) {
      let t = (f + ((j + 0.5) / sub - 0.5) * SHUTTER) / FPS
      if (t < 0) t += DUR
      await page.evaluate(([x, fr]) => window.render(x, fr), [t, f])
      const { data } = await sharp(await grab(cdp))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
      for (let k = 0; k < data.length; k++) acc[k] += data[k]
    }
    const px = Buffer.allocUnsafe(W * H * 3)
    for (let k = 0; k < px.length; k++) px[k] = (acc[k] + (sub >> 1)) / sub
    // backpressure: keep the reorder window small
    while (f - next > WORKERS * 3) await new Promise((r) => setTimeout(r, 5))
    pending.set(f, px)
    await flush()
    if (f % 120 === 0)
      console.log(`frame ${f}/${f1}  ${((Date.now() - started) / 1000).toFixed(0)}s`)
  }
  await browser.close()
}
await Promise.all(Array.from({ length: WORKERS }, (_, w) => worker(w)))
await flush()
ff.stdin.end()
await new Promise((r) => ff.on('close', r))
console.log('wrote', out, `in ${((Date.now() - started) / 1000).toFixed(0)}s`)
