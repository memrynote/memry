#!/usr/bin/env node
/**
 * A compilation cut from finished clips: a title card, a ~3 s excerpt of each clip (its first
 * zoomed-in moment, with that clip's own step caption), short crossfades, the end card.
 *
 *   node marketing/social/engine/montage.mjs <slug>
 *
 * <slug> is either `week-NN` (that week's 🎬 clips, in posting order, from 2026-q4.md) or a folder
 * under clips/ holding montage.json: {"title": "...", "clips": ["slug" | {"slug", "at"}], "seconds"?}.
 * `at` overrides where a clip's excerpt starts (seconds into it). Writes clips/<slug>/out/<slug>.mp4
 * (1920x1080, 60 fps, no audio), .gif, .png and qa/phone-upright.png.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const SOCIAL = path.dirname(ENGINE)
const LOGO = path.resolve(SOCIAL, '../../assets/brand/memrynote/logo.svg')
const FADE = 0.35
const ff = (...a) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' })
const duration = (f) =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' }
    )
  )

/** The 🎬 clips posted in week `n` of the series, in posting order. */
export function weekClips(n) {
  const doc = fs.readFileSync(path.join(SOCIAL, '2026-q4.md'), 'utf8')
  const section = doc.split(/^## /m).find((s) => s.startsWith(`Week ${n}:`))
  if (!section) throw new Error(`No "## Week ${n}:" in 2026-q4.md`)
  return [...new Set([...section.matchAll(/^\*\*X\*\*.*🎬 `([a-z0-9-]+)`/gm)].map((m) => m[1]))]
}

/**
 * Where a clip's excerpt starts: its first zoom after the hook, once the camera has arrived. The
 * take's timeline is gitignored, so a clip recorded in another checkout falls back to its
 * narration.json: the hook length plus the usual 0.9 s the camera needs to arrive.
 */
function excerptStart(slug, seconds, film) {
  const take = path.join(SOCIAL, 'clips', slug, 'out/take')
  const total = duration(film)
  if (!fs.existsSync(path.join(take, 'timeline.json'))) {
    const scenes = JSON.parse(
      fs.readFileSync(path.join(SOCIAL, 'clips', slug, 'narration.json'), 'utf8')
    ).scenes
    const hookEnd = scenes[0].dur
    const lastEnd = total - scenes.at(-1).dur - seconds
    return Math.max(hookEnd + 0.3, Math.min(hookEnd + 1.4, lastEnd))
  }
  const TL = JSON.parse(fs.readFileSync(path.join(take, 'timeline.json'), 'utf8'))
  const events = JSON.parse(fs.readFileSync(path.join(take, 'events.json'), 'utf8'))
  const hookEnd = TL[0].end
  const lastEnd = (TL.at(-1).id === 'end' ? TL.at(-1).t : total) - seconds
  const zoom = events.find((e) => e.type === 'zoom' && e.t >= hookEnd)
  const t = zoom ? zoom.t + 0.9 : TL[1] ? TL[1].t + 0.4 : hookEnd
  return Math.max(hookEnd + 0.3, Math.min(t, lastEnd))
}

async function card(file, text, style) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    await page.goto(pathToFileURL(path.join(ENGINE, 'caption.html')).href)
    // The compositor's wallpaper: cream to orange, 60% along x and 40% along y.
    await page.addStyleTag({
      content: `body { background: linear-gradient(${90 - (Math.atan2(0.4 * 1080, 0.6 * 1920) * 180) / Math.PI}deg, rgb(246,214,186), rgb(236,120,64)) !important }
        #cap.hook { top: 50% !important; transform: translate(-50%, -50%) !important; font-size: 96px !important; padding: 36px 64px !important }`
    })
    await page.evaluate(
      ([t, s, l]) => window.show(t, s, l),
      [text, style, pathToFileURL(LOGO).href]
    )
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: file })
  } finally {
    await browser.close()
  }
}

export async function montage(slug) {
  const week = slug.match(/^week-(\d+)$/)
  const dir = path.join(SOCIAL, 'clips', slug)
  const cfg = week
    ? { title: 'This week in *memrynote*', clips: weekClips(Number(week[1])) }
    : JSON.parse(fs.readFileSync(path.join(dir, 'montage.json'), 'utf8'))
  const seconds = cfg.seconds ?? 3
  const out = path.join(dir, 'out')
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(path.join(out, 'cards'), { recursive: true })

  const parts = cfg.clips.map((c) => {
    const s = typeof c === 'string' ? { slug: c } : c
    const recorded = path.join(SOCIAL, 'clips', s.slug, 'out', `${s.slug}.mp4`)
    const approved = path.join(SOCIAL, 'media', `${s.slug}.mp4`)
    const film = fs.existsSync(recorded) ? recorded : approved
    if (!fs.existsSync(film)) throw new Error(`${s.slug} has no film yet: ${film}`)
    return { ...s, film, at: s.at ?? excerptStart(s.slug, seconds, film) }
  })
  const title = path.join(out, 'cards/title.png')
  const end = path.join(out, 'cards/end.png')
  await card(title, cfg.title, 'hook')
  await card(end, 'free on mac, windows and linux', 'end')

  const TITLE = 2.2
  const END = 2.4
  const inputs = [
    ['-loop', '1', '-t', String(TITLE + FADE), '-i', title],
    ...parts.map((p) => ['-ss', p.at.toFixed(2), '-t', String(seconds + FADE), '-i', p.film]),
    ['-loop', '1', '-t', String(END), '-i', end]
  ]
  const n = inputs.length
  const norm = inputs.map(
    (_, i) => `[${i}:v]fps=60,scale=1920:1080,setsar=1,format=yuv420p,settb=AVTB[v${i}]`
  )
  const chain = []
  let prev = 'v0'
  let offset = TITLE
  for (let i = 1; i < n; i++) {
    const outLabel = i === n - 1 ? 'vout' : `x${i}`
    chain.push(
      `[${prev}][v${i}]xfade=transition=fade:duration=${FADE}:offset=${offset.toFixed(3)}[${outLabel}]`
    )
    prev = outLabel
    offset += i < n - 1 ? seconds : 0
  }
  const film = path.join(out, `${slug}.mp4`)
  ff(
    ...inputs.flat(),
    '-filter_complex',
    [...norm, ...chain].join(';'),
    '-map',
    '[vout]',
    '-an',
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'medium',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-r',
    '60',
    film
  )
  const total = duration(film)
  ff(
    '-t',
    '15',
    '-i',
    film,
    '-vf',
    'fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4',
    '-loop',
    '0',
    path.join(out, `${slug}.gif`)
  )
  ff(
    '-ss',
    (TITLE + seconds / 2).toFixed(2),
    '-i',
    film,
    '-frames:v',
    '1',
    path.join(out, `${slug}.png`)
  )

  // QA: the title, the middle of every excerpt and the end card on one phone-sized sheet.
  const qa = path.join(out, 'qa')
  fs.mkdirSync(path.join(qa, 'sheet'), { recursive: true })
  const moments = [1, ...parts.map((_, i) => TITLE + i * seconds + seconds / 2), total - 1]
  moments.forEach((t, i) =>
    ff(
      '-ss',
      t.toFixed(2),
      '-i',
      film,
      '-frames:v',
      '1',
      '-vf',
      'scale=390:-1',
      path.join(qa, 'sheet', `${String(i).padStart(2, '0')}.png`)
    )
  )
  ff(
    '-framerate',
    '1',
    '-i',
    path.join(qa, 'sheet/%02d.png'),
    '-vf',
    `tile=3x${Math.ceil(moments.length / 3)}:padding=4:margin=4:color=white`,
    '-frames:v',
    '1',
    path.join(qa, 'phone-upright.png')
  )
  fs.rmSync(path.join(qa, 'sheet'), { recursive: true })
  console.log(
    `  ${film}\n  ${total.toFixed(1)}s, ${parts.length} clips: ${parts.map((p) => `${p.slug}@${p.at.toFixed(1)}`).join(', ')}`
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: montage.mjs <week-NN | slug>')
  await montage(process.argv[2])
}
