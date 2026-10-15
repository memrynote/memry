// Evidence for the finished film, because the agent can neither watch nor listen:
// loudness meters, Scribe's transcript of the final mix, and stills for every scene and zoom.
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { transcribe, wer } from './eleven.mjs'

const ff = (args) =>
  execFileSync('ffmpeg', ['-hide_banner', '-nostats', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
// ffmpeg's meters print to stderr.
const ffErr = (args) =>
  spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8' }).stderr

export async function qa(dir) {
  const slug = path.basename(dir)
  const film = path.join(dir, 'out', `${slug}.mp4`)
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const TL = JSON.parse(fs.readFileSync(path.join(dir, 'out/take/timeline.json'), 'utf8'))
  const events = JSON.parse(fs.readFileSync(path.join(dir, 'out/take/events.json'), 'utf8'))
  const problems = []

  // Loudness: YouTube plays at -14 LUFS; keep true peak under -1 dBFS.
  const meter = ffErr(['-i', film, '-af', 'ebur128=peak=true', '-f', 'null', '-'])
    .split('Summary:')
    .pop()
  const lufs = Number(meter.match(/I:\s+(-?[\d.]+) LUFS/)[1])
  const peak = Number(meter.match(/Peak:\s+(-?[\d.]+) dBFS/)[1])
  if (Math.abs(lufs + 14) > 1) problems.push(`loudness ${lufs} LUFS, want -14 ± 1`)
  if (peak > -1) problems.push(`true peak ${peak} dBFS, want <= -1`)

  // Intelligibility: Scribe must hear the script in the finished mix, music and all.
  const mixMp3 = path.join(dir, 'out', 'qa-mix.mp3')
  ff(['-y', '-loglevel', 'error', '-i', film, '-vn', '-ac', '1', '-b:a', '128k', mixMp3])
  const heard = await transcribe(mixMp3)
  fs.rmSync(mixMp3)
  const said = N.scenes.map((s) => s.text.replaceAll('{brand}', N.brand)).join(' ')
  const score = wer(said, heard)
  if (score > 0.05)
    problems.push(
      `Scribe word error rate ${(score * 100).toFixed(1)}% on the final mix, want <= 5%`
    )

  // Stills: the middle of every scene and of every zoom, for the agent to look at.
  const qaDir = path.join(dir, 'out/qa')
  fs.rmSync(qaDir, { recursive: true, force: true })
  fs.mkdirSync(qaDir, { recursive: true })
  const stills = TL.map((s) => [`${s.id}`, (s.t + s.end) / 2])
  const zooms = events.filter((e) => e.type === 'zoom')
  for (const z of zooms) {
    const next = events.find((e) => e.t > z.t && (e.type === 'zoom' || e.type === 'unzoom'))
    stills.push([`zoom-${TL.findLast((s) => s.t <= z.t).id}`, next ? (z.t + next.t) / 2 : z.t + 2])
  }
  // Cards: the mark alone, the lockup, every topic pill, mid-morph; the end card in and at rest.
  const cardsFile = path.join(dir, 'out/cards/cards.json')
  if (fs.existsSync(cardsFile)) {
    const { intro, outro } = JSON.parse(fs.readFileSync(cardsFile, 'utf8'))
    if (intro) {
      const T = intro.timing
      stills.push(
        ['card-mark', 0.4],
        ['card-lockup', 1.2],
        ['card-topics', T.morph - 0.1],
        ['card-morph', T.reveal - 0.15]
      )
    }
    if (outro)
      stills.push(['endcard-in', outro.timing.start + 0.5], ['endcard-rest', outro.end - 0.1])
  }
  stills.sort((a, b) => a[1] - b[1])
  stills.forEach(([name, t], i) => {
    const f = path.join(qaDir, `${String(i).padStart(2, '0')}-${name}-${t.toFixed(1)}s.png`)
    ff([
      '-y',
      '-loglevel',
      'error',
      '-ss',
      t.toFixed(2),
      '-i',
      film,
      '-frames:v',
      '1',
      '-vf',
      'scale=1280:-1',
      f
    ])
  })

  const duration = Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', film],
      { encoding: 'utf8' }
    )
  )
  const report = {
    film,
    duration: Number(duration.toFixed(1)),
    lufs,
    peak,
    wer: Number(score.toFixed(3)),
    heard,
    stills: fs.readdirSync(qaDir).map((f) => path.join(qaDir, f)),
    problems
  }
  fs.writeFileSync(path.join(dir, 'out/qa.json'), JSON.stringify(report, null, 1))
  return report
}
