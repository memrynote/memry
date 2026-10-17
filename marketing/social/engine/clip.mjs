#!/usr/bin/env node
/**
 * One social clip, end to end: vault -> record (+ checks) -> captions -> compose -> export -> qa.
 *
 *   node marketing/social/engine/clip.mjs <slug>                  # vault (if needed), then record onwards
 *   node marketing/social/engine/clip.mjs <slug> --seed           # rebuild the clip's vault first
 *   node marketing/social/engine/clip.mjs <slug> --from compose   # re-cut the last take
 *   node marketing/social/engine/clip.mjs <slug> --open           # start the app on the clip's vault and leave it running
 *   node marketing/social/engine/clip.mjs <slug> --close          # stop that app
 *
 * Options: --slot N runs on its own ports and temp dir, so several agents can work at once (takes still queue one at a time)
 * (also MEMRY_SOCIAL_SLOT). --app <checkout> films that checkout's desktop build (also
 * MEMRY_SOCIAL_APP; default this checkout). --seed-base rebuilds today's base vault.
 *
 * <slug> is a folder under marketing/social/clips/ holding a silent narration.json (each scene's
 * caption and length in seconds), scenes.mjs (what happens on screen, with the tutorial engine's
 * ctx) and optionally vault.mjs (data the clip needs on top of the base vault). The recorder, the
 * app driver and the compositor are the tutorial engine's (marketing/tutorials/engine/), in its
 * silent mode. Writes clips/<slug>/out/: <slug>.mp4 (1920x1080, 60 fps, no audio), <slug>.gif,
 * <slug>.png and qa/ stills to look at. See marketing/social/README.md.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { query, startApp, stopApp, useApp } from '../../tutorials/engine/app.mjs'
import { encode } from '../../tutorials/engine/encode.mjs'
import { record } from '../../tutorials/engine/record.mjs'
import { TIMEZONE, at, cliFor, day, writer } from '../vault/cli.mjs'
import { seedBase } from '../vault/seed.mjs'
import { renderCaptions } from './captions.mjs'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const SOCIAL = path.dirname(ENGINE)
const REPO = path.resolve(SOCIAL, '../..')
const TUTORIAL_ENGINE = path.join(REPO, 'marketing/tutorials/engine')
const ASSETS = path.join(SOCIAL, 'vault/assets')
const STEPS = ['record', 'captions', 'compose', 'export', 'qa']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const has = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args.splice(i, 1).length > 0
}
const [seed, seedBaseFlag, open, close] = ['seed', 'seed-base', 'open', 'close'].map(has)
const from = flag('from')
const slot = Number(flag('slot') ?? process.env.MEMRY_SOCIAL_SLOT ?? 0)
const app = path.resolve(flag('app') ?? process.env.MEMRY_SOCIAL_APP ?? REPO)
process.env.MEMRY_SOCIAL_APP = app
const slug = args[0]
if (!slug || (from && !STEPS.includes(from))) {
  console.error(
    `Usage: clip.mjs <slug> [--seed] [--from ${STEPS.join('|')}] [--open|--close] [--slot N] [--app <checkout>]`
  )
  process.exit(1)
}

// A slot is a second (third) app: agent-app.mjs and pw.mjs read the ports, and agent-app keeps
// its state file, user data and vault copy under the temp dir.
if (slot) {
  process.env.MEMRY_AGENT_CDP_PORT = String(9222 + 10 * slot)
  process.env.MEMRY_AGENT_INSPECT_PORT = String(9229 + 10 * slot)
  process.env.TMPDIR = `/tmp/memry-social/slot-${slot}`
  fs.mkdirSync(process.env.TMPDIR, { recursive: true })
}
useApp(app)
if (close) {
  stopApp()
  process.exit(0)
}

const dir = path.join(SOCIAL, 'clips', slug)
// Compilations (week-NN, or a folder with montage.json) are cut from finished clips.
if (/^week-\d+$/.test(slug) || fs.existsSync(path.join(dir, 'montage.json'))) {
  const { montage } = await import('./montage.mjs')
  await montage(slug)
  process.exit(0)
}
const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
if (!N.silent) throw new Error(`${slug}/narration.json must be a silent film ("silent": true)`)
const out = path.join(dir, 'out')
const film = path.join(out, `${slug}.mp4`)
const ff = (...a) =>
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...a], { stdio: 'inherit' })

// Vaults are rebuilt each day, because the seeds date everything relative to today.
const VAULTS = `/tmp/memry-social/vaults/${day(0)}`
async function vaultAt(dir, make, rebuild) {
  const vault = path.join(dir, 'Maya')
  if (fs.existsSync(vault) && !rebuild) return vault
  const tmp = `${dir}.tmp-${process.pid}`
  fs.rmSync(tmp, { recursive: true, force: true })
  await make(path.join(tmp, 'Maya'))
  if (rebuild) fs.rmSync(dir, { recursive: true, force: true })
  try {
    fs.renameSync(tmp, dir)
  } catch (err) {
    // Another slot built the same vault first; theirs is as good as ours.
    if (!fs.existsSync(vault)) throw err
    fs.rmSync(tmp, { recursive: true, force: true })
  }
  return vault
}
async function clipVault() {
  const base = await vaultAt(
    path.join(VAULTS, 'base'),
    (vault) => seedBase({ app, vault }),
    seedBaseFlag
  )
  const extra = path.join(dir, 'vault.mjs')
  if (!fs.existsSync(extra)) return base
  return vaultAt(
    path.join(VAULTS, slug),
    async (vault) => {
      fs.cpSync(base, vault, { recursive: true })
      const { default: extend } = await import(pathToFileURL(extra).href)
      await extend({
        cli: cliFor(app, vault),
        vault,
        day,
        at,
        TIMEZONE,
        write: writer(vault),
        assets: ASSETS
      })
    },
    seed || seedBaseFlag
  )
}

function start(vault) {
  const main = path.join(app, 'apps/desktop/out/main/index.js')
  if (!fs.existsSync(main))
    throw new Error(
      `No desktop build in ${app}. Run there: pnpm --filter @memry/desktop exec electron-vite build`
    )
  const version = execFileSync('git', ['-C', app, 'describe', '--tags', '--always'], {
    encoding: 'utf8'
  }).trim()
  console.log(
    `  filming ${app} (${version}), slot ${slot}, CDP :${process.env.MEMRY_AGENT_CDP_PORT ?? 9222}`
  )
  startApp(vault)
}

const steps = open ? [] : STEPS.slice(from ? STEPS.indexOf(from) : 0)
const step = (s) => steps.includes(s) && (console.log(`\n== ${s}`), true)

if (open) {
  const vault = await clipVault()
  start(vault)
  console.log(
    `  open on ${vault}. Explore with: node marketing/social/engine/probe.mjs --slot ${slot} ...`
  )
}

// One take at a time across slots: two screencasts at once each get fewer frames, and a choppy
// cursor is the first thing a viewer notices.
const LOCK = '/tmp/memry-social/record.lock'
async function takeTurn() {
  for (let waited = 0; ; waited += 2) {
    try {
      fs.mkdirSync(LOCK)
      fs.writeFileSync(path.join(LOCK, 'owner'), `${process.pid} ${slug}`)
      let held = true
      return () => {
        if (held) fs.rmSync(LOCK, { recursive: true, force: true })
        held = false
      }
    } catch {
      const [pid, who] = (
        fs.existsSync(path.join(LOCK, 'owner'))
          ? fs.readFileSync(path.join(LOCK, 'owner'), 'utf8')
          : ''
      ).split(' ')
      let alive = false
      try {
        alive = !!pid && process.kill(Number(pid), 0)
      } catch {}
      if (pid && !alive) fs.rmSync(LOCK, { recursive: true, force: true })
      else if (waited % 30 === 0) console.log(`  waiting for ${who ?? 'another'} take to finish...`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}

// A clip with `"page": "<file>.html"` or `"page": "https://..."` in narration.json films that page
// (a terminal replay, an animated diagram, a live web page) in headless Chromium at the app's
// size, instead of the app.
if (N.page && step('record')) {
  const { chromium } = await import('playwright')
  // The screencast sends frames at the device scale factor only when it is forced on the command
  // line; the context's deviceScaleFactor alone still yields 1600x900 frames.
  const browser = await chromium.launch({ args: ['--force-device-scale-factor=2'] })
  let release = () => {}
  try {
    const context = await browser.newContext({
      viewport: { width: 1600, height: 900 },
      deviceScaleFactor: 2
    })
    const page = await context.newPage()
    await page.goto(/^https?:/.test(N.page) ? N.page : pathToFileURL(path.join(dir, N.page)).href, {
      waitUntil: 'networkidle'
    })
    await page.evaluate(() => document.fonts.ready)
    // Scenes that replay real commands run them on this vault.
    process.env.MEMRY_SOCIAL_VAULT = await clipVault()
    release = await takeTurn()
    const timeline = await record(dir, { page })
    release()
    const total = timeline.at(-1).end + 0.3
    console.log(`  ${encode(path.join(out, 'take'), total)} frames, ${total.toFixed(1)}s`)
  } finally {
    release()
    await browser.close()
  }
}

if (!N.page && step('record')) {
  const vault = await clipVault()
  start(vault)
  let release = () => {}
  try {
    await new Promise((r) => setTimeout(r, 2500))
    release = await takeTurn()
    const timeline = await record(dir)
    release()
    const total = timeline.at(-1).end + 0.3
    console.log(`  ${encode(path.join(out, 'take'), total)} frames, ${total.toFixed(1)}s`)
    const { checks = [] } = await import(pathToFileURL(path.join(dir, 'scenes.mjs')).href)
    const failed = checks.flatMap(([what, fn]) => {
      const err = fn(query)
      console.log(`  ${err ? 'FAIL' : 'ok  '} ${what}`)
      return err ? [`${what}: ${err}`] : []
    })
    if (failed.length) throw new Error(`Recording checks failed:\n${failed.join('\n')}`)
  } finally {
    release()
    stopApp()
  }
}

if (step('captions')) console.log(`  ${(await renderCaptions(dir)).length} captions`)

if (step('compose')) {
  execFileSync(
    'uv',
    [
      'run',
      '-q',
      '--with',
      'pillow',
      '--with',
      'numpy',
      '--with',
      'scipy',
      'python',
      path.join(TUTORIAL_ENGINE, 'compose.py'),
      dir
    ],
    { stdio: 'inherit' }
  )
}

const TL = () => JSON.parse(fs.readFileSync(path.join(out, 'take/timeline.json'), 'utf8'))

if (step('export')) {
  // faststart puts the index first, so X and Reddit start playing before the file has arrived.
  const tmp = path.join(out, `${slug}.faststart.mp4`)
  ff('-i', film, '-c', 'copy', '-movflags', '+faststart', tmp)
  fs.renameSync(tmp, film)
  // GIF for places that take no video: the first 15 s, 12 fps, 960 px wide.
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
  // Still for image posts and link previews: `poster` seconds in, or the middle of the last scene.
  const last = TL().at(-1)
  const poster = N.poster ?? (last.t + last.end) / 2
  ff('-ss', poster.toFixed(2), '-i', film, '-frames:v', '1', path.join(out, `${slug}.png`))
}

if (step('qa')) {
  // The agent can't watch the clip, so it reads stills: the first frame (the hook), the middle of
  // every scene, and every zoom, at 844 px (a phone held sideways), plus all of them on one sheet
  // at 390 px (a phone held upright).
  const qa = path.join(out, 'qa')
  fs.rmSync(qa, { recursive: true, force: true })
  fs.mkdirSync(qa, { recursive: true })
  const events = JSON.parse(fs.readFileSync(path.join(out, 'take/events.json'), 'utf8'))
  const moments = [['hook', 0.05], ...TL().map((s) => [s.id, (s.t + s.end) / 2])]
  for (const z of events.filter((e) => e.type === 'zoom')) {
    const next = events.find((e) => e.t > z.t && ['zoom', 'unzoom'].includes(e.type))
    moments.push([
      `zoom-${TL().findLast((s) => s.t <= z.t)?.id}`,
      next ? (z.t + next.t) / 2 : z.t + 1.5
    ])
  }
  moments.sort((a, b) => a[1] - b[1])
  const sheet = path.join(qa, 'upright')
  fs.mkdirSync(sheet)
  moments.forEach(([name, t], i) => {
    const n = String(i).padStart(2, '0')
    ff(
      '-ss',
      t.toFixed(2),
      '-i',
      film,
      '-frames:v',
      '1',
      '-vf',
      'scale=844:-1',
      path.join(qa, `${n}-${name}-${t.toFixed(1)}s.png`)
    )
    ff(
      '-ss',
      t.toFixed(2),
      '-i',
      film,
      '-frames:v',
      '1',
      '-vf',
      'scale=390:-1',
      path.join(sheet, `${n}.png`)
    )
  })
  ff(
    '-framerate',
    '1',
    '-i',
    path.join(sheet, '%02d.png'),
    '-vf',
    `tile=3x${Math.ceil(moments.length / 3)}:padding=4:margin=4:color=white`,
    '-frames:v',
    '1',
    path.join(qa, 'phone-upright.png')
  )
  fs.rmSync(sheet, { recursive: true })
  const probe = (f, what) =>
    execFileSync('ffprobe', ['-v', 'error', ...what, '-of', 'csv=p=0', f], {
      encoding: 'utf8'
    }).trim()
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1)
  console.log(
    `  ${film}\n  ${Number(probe(film, ['-show_entries', 'format=duration'])).toFixed(1)}s, ` +
      `${probe(film, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate'])}, ` +
      `audio streams: ${probe(film, ['-select_streams', 'a', '-show_entries', 'stream=index']).split('\n').filter(Boolean).length}, ` +
      `mp4 ${mb(film)} MB, gif ${mb(path.join(out, `${slug}.gif`))} MB`
  )
  console.log(`  ${moments.length} stills in ${qa} (look at every one)`)
}
