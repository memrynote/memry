// Usage: node render.mjs [out.mp4] [--stills t1,t2,...]
import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const dir = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const stillsArg = args.indexOf('--stills')
const FPS = 60,
  DUR = 40

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
await page.goto(pathToFileURL(path.join(dir, 'index.html')).href)
await page.evaluate(() => window.ready)

if (stillsArg >= 0) {
  for (const t of args[stillsArg + 1].split(',')) {
    await page.evaluate((x) => window.render(x), +t)
    await page.screenshot({ path: `/tmp/memry-still-${t}.png` })
  }
} else {
  const out = path.resolve(dir, args[0] ?? 'memrynote-launch.mp4')
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-f',
      'image2pipe',
      '-framerate',
      String(FPS),
      '-c:v',
      'mjpeg',
      '-i',
      '-',
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '15',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out
    ],
    { stdio: ['pipe', 'ignore', 'inherit'] }
  )
  const total = FPS * DUR
  for (let f = 0; f < total; f++) {
    await page.evaluate((x) => window.render(x), f / FPS)
    const buf = await page.screenshot({ type: 'jpeg', quality: 96 })
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r))
    if (f % 300 === 0) console.log(`frame ${f}/${total}`)
  }
  ff.stdin.end()
  await new Promise((r) => ff.on('close', r))
  console.log('wrote', out)
}
await browser.close()
