// Frame renderer for index.html (same pipeline as ../explainer-30s/render.mjs).
//   node render.mjs --stills 2,4.5,8          -> PNG stills in /tmp/memry-release/stills
//   node render.mjs --events                   -> events.json (cue list the score reads)
//   node render.mjs --out video.mp4 [--sub 6] [--workers 10] [--from 0 --to 40] [--crf 12]
//   node render.mjs --out draft.mp4 --sub 1    -> quick draft, no motion blur
// Motion blur: each output frame averages samples across a 180-degree shutter; fast frames get more
// (window.samplesAt in index.html), `--sub N` forces a fixed count.
// render(t) returns a promise while the vault section waits on a recording frame; evaluate awaits it.
import { chromium } from 'playwright'
import sharp from 'sharp'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const TL = JSON.parse(
  readFileSync(path.join(dir, 'timeline.js'), 'utf8')
    .split('=')
    .slice(1)
    .join('=')
    .trim()
    .replace(/;\s*$/, '')
)
const argv = process.argv.slice(2)
const arg = (k, d) => {
  const i = argv.indexOf('--' + k)
  return i >= 0 ? argv[i + 1] : d
}
const has = (k) => argv.includes('--' + k)
const FPS = TL.fps,
  DUR = TL.dur,
  W = 1920,
  H = 1080
// Served over http, not file://: the film reads screenshot pixels (color sampling, theme repaint),
// and file:// images taint the canvas.
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
}
// The vault section plays shots/vaults.mp4 frame by frame. Frames are extracted once into frames/vault
// (gitignored): 000.jpg is the first frame, frame i sits at i/60 s.
const FRAMES = path.join(dir, 'frames/vault')
if (!existsSync(path.join(FRAMES, '000.jpg'))) {
  mkdirSync(FRAMES, { recursive: true })
  const r = spawnSync(
    'ffmpeg',
    [
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.join(dir, 'shots/vaults.mp4'),
      '-q:v',
      '2',
      '-start_number',
      '0',
      path.join(FRAMES, '%03d.jpg')
    ],
    { stdio: 'inherit' }
  )
  if (r.status !== 0) throw new Error('could not extract frames from shots/vaults.mp4')
}
const server = createServer((req, res) => {
  const file = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname))
  if (!file.startsWith(dir)) return res.writeHead(403).end()
  try {
    const body = readFileSync(file)
    res
      .writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' })
      .end(body)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/index.html`

async function openPage(browser) {
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  page.on('pageerror', (e) => console.error('pageerror:', e.message))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error('console:', m.text())
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
    const out = arg('dir', '/tmp/memry-release/stills')
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
  server.close()
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
    'film',
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
      const off = sub === 1 ? 0 : ((j + 0.5) / sub - 0.5) * SHUTTER
      const t = Math.min(Math.max((f + off) / FPS, 0), DUR - 1e-4)
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
server.close()
console.log('wrote', out, `in ${((Date.now() - started) / 1000).toFixed(0)}s`)
