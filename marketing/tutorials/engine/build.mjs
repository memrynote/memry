#!/usr/bin/env node
/**
 * One tutorial, end to end:
 *   check -> seed -> narrate -> record (+ checks) -> compose (cards, picture, sound) -> qa
 *   -> youtube (title, description, tags and thumbnails, when narration.json has a youtube block)
 *
 *   node marketing/tutorials/engine/build.mjs <tutorial>                 # everything
 *   node marketing/tutorials/engine/build.mjs <tutorial> --from record   # keep narration, re-shoot
 *   node marketing/tutorials/engine/build.mjs <tutorial> --only narrate  # voice only
 *   node marketing/tutorials/engine/build.mjs <tutorial> --takes 3       # more takes per line
 *   node marketing/tutorials/engine/build.mjs <tutorial> --app <checkout> # film another checkout's build
 *   node marketing/tutorials/engine/build.mjs <tutorial> --only youtube  # metadata + thumbnails again
 *
 * <tutorial> is a folder under marketing/tutorials/ holding narration.json and scenes.mjs.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { query, startApp, stopApp, useApp } from './app.mjs'
import { renderCards } from './card.mjs'
import { quota } from './eleven.mjs'
import { encode } from './encode.mjs'
import { narrate } from './narrate.mjs'
import { qa } from './qa.mjs'
import { record } from './record.mjs'
import { renderThumbs } from './thumb.mjs'
import { buildMetadata } from './youtube.mjs'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const TUTORIALS = path.dirname(ENGINE)
const ROOT = path.resolve(TUTORIALS, '../..')
const VAULT = '/tmp/memry-tutorials/vault/Tutorial'
const STEPS = ['check', 'seed', 'narrate', 'record', 'compose', 'qa', 'youtube']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i < 0 ? undefined : args.splice(i, 2)[1]
}
const from = flag('from')
const only = flag('only')
const takes = Number(flag('takes') ?? 2)
const APP = path.resolve(flag('app') ?? ROOT)
useApp(APP)
const name = args[0]
if (!name) {
  console.error(
    `Usage: build.mjs <tutorial> [--from ${STEPS.join('|')}] [--only <step>] [--takes n]`
  )
  process.exit(1)
}
const dir = path.join(TUTORIALS, name)
if (!fs.existsSync(path.join(dir, 'narration.json')))
  throw new Error(`${dir}/narration.json missing`)
const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
const steps = only ? [only] : STEPS.slice(from ? STEPS.indexOf(from) : 0)
if (!steps.length || steps.some((s) => !STEPS.includes(s)))
  throw new Error(`Unknown step. Steps: ${STEPS.join(', ')}`)
const step = (s) => steps.includes(s) && (console.log(`\n== ${s}`), true)

if (steps.includes('check') || steps.includes('record')) {
  step('check')
  const missing = ['ffmpeg', 'ffprobe', 'uv'].filter(
    (bin) => spawnSync('which', [bin]).status !== 0
  )
  if (missing.length)
    throw new Error(
      `Missing ${missing.join(', ')}. Install with: brew install ${missing.map((b) => (b === 'ffprobe' ? 'ffmpeg' : b)).join(' ')}`
    )
  console.log(
    `  filming ${APP} (${execFileSync('git', ['-C', APP, 'log', '-1', '--format=%h %s'], { encoding: 'utf8' }).trim()})`
  )
  const main = path.join(APP, 'apps/desktop/out/main/index.js')
  if (!fs.existsSync(main))
    throw new Error(
      `No desktop build in ${APP}. Run there: pnpm --filter @memry/desktop exec electron-vite build`
    )
  const age = (Date.now() - fs.statSync(main).mtimeMs) / 36e5
  const head =
    execFileSync('git', ['-C', APP, 'log', '-1', '--format=%ct'], { encoding: 'utf8' }) * 1000
  if (fs.statSync(main).mtimeMs < head)
    console.warn(
      `  warning: desktop build (${age.toFixed(1)} h old) is older than HEAD; rebuild to film the current app`
    )
  const q = await quota()
  console.log(`  ElevenLabs ${q.tier}: ${q.used}/${q.limit} characters used`)
}

if (step('seed')) {
  execFileSync('node', [path.join(TUTORIALS, 'vault/seed.mjs'), VAULT], { stdio: 'inherit' })
}

if (step('narrate')) await narrate(dir, { takes })

if (step('record')) {
  if (!fs.existsSync(VAULT)) throw new Error(`No tutorial vault at ${VAULT}. Run with --from seed`)
  startApp(VAULT)
  try {
    await new Promise((r) => setTimeout(r, 2500))
    const timeline = await record(dir)
    const total = timeline.at(-1).end + 0.3
    console.log(`  ${encode(path.join(dir, 'out/take'), total)} frames, ${total.toFixed(1)}s`)
    const { checks = [] } = await import(pathToFileURL(path.join(dir, 'scenes.mjs')).href)
    const failed = checks.flatMap(([what, fn]) => {
      const err = fn(query)
      return err ? [`${what}: ${err}`] : []
    })
    for (const [what] of checks)
      console.log(`  ${failed.some((f) => f.startsWith(what)) ? 'FAIL' : 'ok  '} ${what}`)
    if (failed.length) throw new Error(`Recording checks failed:\n${failed.join('\n')}`)
  } finally {
    stopApp()
  }
}

if (step('compose')) {
  await renderCards(dir)
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
      path.join(ENGINE, 'compose.py'),
      dir
    ],
    { stdio: 'inherit' }
  )
}

if (step('qa')) {
  const r = await qa(dir)
  console.log(
    `  ${r.film}\n  ${r.duration}s, ${r.lufs} LUFS, peak ${r.peak} dBFS, Scribe WER ${(r.wer * 100).toFixed(1)}%`
  )
  console.log(`  ${r.stills.length} stills in ${path.join(dir, 'out/qa')} (look at every one)`)
  if (r.problems.length) {
    console.error(`  PROBLEMS:\n  - ${r.problems.join('\n  - ')}`)
    process.exitCode = 1
  }
}

if (step('youtube')) {
  if (!N.youtube) console.log('  no youtube block in narration.json, so nothing to package')
  else {
    const meta = buildMetadata(dir)
    const thumbs = await renderThumbs(dir)
    for (const w of [...meta.warnings, ...thumbs.warnings]) console.log(`  warning: ${w}`)
    console.log(
      `  title ${meta.titleChars}/100 characters, description ${meta.bytes}/5000 bytes, tags ${meta.tagChars}/500, ${meta.chapters} chapters`
    )
    console.log(
      `  ${thumbs.files.length} thumbnails; look at ${path.basename(dir)}.thumbs.png in ${path.join(dir, 'out')}`
    )
  }
}
