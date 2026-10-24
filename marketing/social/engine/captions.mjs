// A silent clip's captions: one transparent 1920x1080 PNG per scene that has `text`, drawn by
// caption.html in the brand font, and out/captions/captions.json, which compose.py lays over the
// film. The first scene's caption is the hook and is on screen from the first frame, above the
// window (compose.py keeps the window small and low until the hook leaves); the others fade in
// when their scene starts. A scene's `style` (hook, step, end) overrides the default.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const LOGO = path.resolve(ENGINE, '../../../assets/brand/memrynote/logo.svg')

export async function renderCaptions(dir) {
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const TL = JSON.parse(fs.readFileSync(path.join(dir, 'out/take/timeline.json'), 'utf8'))
  const out = path.join(dir, 'out/captions')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(path.join(ENGINE, 'caption.html')).href)
    const list = []
    for (const [i, s] of N.scenes.entries()) {
      if (!s.text) continue
      const scene = TL.find((x) => x.id === s.id)
      const style = s.style ?? (i === 0 ? 'hook' : 'step')
      await page.evaluate(
        ([text, captionStyle, logo]) => window.show(text, captionStyle, logo),
        [s.text, style, pathToFileURL(LOGO).href]
      )
      await page.evaluate(() => document.fonts.ready)
      const file = `${String(i).padStart(2, '0')}-${s.id}.png`
      await page.screenshot({ path: path.join(out, file), omitBackground: true })
      list.push({ file, style, t0: i === 0 ? 0 : scene.t, t1: scene.end, fadeIn: i !== 0 })
    }
    fs.writeFileSync(path.join(out, 'captions.json'), JSON.stringify(list, null, 1))
    return list
  } finally {
    await browser.close()
  }
}
