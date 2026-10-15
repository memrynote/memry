// Title and end cards: card.html rendered frame by frame (60 fps, transparent) over the film's
// wallpaper. Writes out/cards/{intro,outro}/NNNNN.png and out/cards/cards.json for compose.py.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const LOGO = path.resolve(ENGINE, '../../../assets/brand/memrynote/logo.svg')
const FPS = 60

/** The master logo, with the wordmark split into the syllables mem / ry / note. */
function logoParts() {
  const svg = fs.readFileSync(LOGO, 'utf8')
  const mark = svg.match(/<path xmlns="http:\/\/www.w3.org\/2000\/svg" d="[^"]+"[^>]*\/>/)[0]
  const word = svg.match(
    /<g transform="translate\(40, 0\)"><path d="([^"]+)" fill="(#[0-9A-Fa-f]+)"/
  )
  const words = ['', '', '']
  for (const sub of word[1].split(/(?=M)/)) {
    const x = parseFloat(sub.slice(1))
    words[x < 63 ? 0 : x < 87.5 ? 1 : 2] += sub
  }
  return { mark, words, wordColor: word[2] }
}

/** Seconds into a scene's line where `phrase` starts. */
function wordAt(dir, id, phrase) {
  const { alignment: a } = JSON.parse(fs.readFileSync(path.join(dir, 'vo', `${id}.json`), 'utf8'))
  const i = a.characters.join('').indexOf(phrase)
  if (i < 0) throw new Error(`"${phrase}" is not in the narration of ${id}`)
  return a.character_start_times_seconds[i]
}

export async function renderCards(dir) {
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const TL = JSON.parse(fs.readFileSync(path.join(dir, 'out/take/timeline.json'), 'utf8'))
  const outDir = path.join(dir, 'out/cards')
  fs.rmSync(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  const plan = {}

  if (N.card) {
    // The title card covers the whole first scene; its line is read over the card.
    const s = TL[0]
    const topics = N.card.topics
    const from = Math.max(2.3, s.vo + 0.3)
    const to = s.vo + s.dur * 0.55
    const step = (to - from) / Math.max(1, topics.length - 1)
    const end = s.end
    plan.intro = {
      kind: 'intro',
      label: N.card.label ?? 'Tutorial',
      title: N.card.title,
      topics,
      start: 0,
      end,
      timing: {
        topics: topics.map((_, i) => from + i * step),
        morph: end - 1.0,
        reveal: end - 0.35,
        end
      }
    }
  }
  if (N.endCard) {
    const s = TL.at(-1)
    const start = s.vo + wordAt(dir, s.id, N.endCard.at) - 0.2
    plan.outro = {
      kind: 'outro',
      url: N.endCard.url ?? 'memrynote.com',
      start,
      // Hold to the film's last frame: encode cuts 0.3 s after the last scene.
      end: s.end + 0.3,
      timing: { start }
    }
  }

  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
  await page.goto(pathToFileURL(path.join(ENGINE, 'card.html')).href)
  await page.evaluate(() => document.fonts.ready)
  const logo = logoParts()
  for (const [name, card] of Object.entries(plan)) {
    const frames = path.join(outDir, name)
    fs.mkdirSync(frames, { recursive: true })
    await page.evaluate((P) => window.setup(P), { ...card, logo })
    const first = Math.floor(card.start * FPS)
    const last = Math.ceil(card.end * FPS)
    for (let n = first; n <= last; n++) {
      await page.evaluate((t) => window.render(t), n / FPS)
      await page.screenshot({
        path: path.join(frames, `${String(n).padStart(5, '0')}.png`),
        omitBackground: true
      })
    }
    card.frames = [first, last]
    console.log(
      `  ${name} card: ${last - first + 1} frames, ${card.start.toFixed(2)}-${card.end.toFixed(2)}s`
    )
  }
  await browser.close()
  fs.writeFileSync(path.join(outDir, 'cards.json'), JSON.stringify(plan, null, 1))
  return plan
}
