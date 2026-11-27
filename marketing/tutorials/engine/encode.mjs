// A take -> take.mp4 at constant 60 fps (libx264 -crf 16 -preset slow), cut at `total` film seconds.
// A screen take (raw.mkv) is trimmed by its lead and its fast-forward spans are cut out, retimed
// with setpts=PTS/<rate> and concatenated. A screencast take (frames.json, variable rate) goes
// through the concat demuxer; `-t` cuts at its end, since the repeated last entry would otherwise
// hold it twice.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const X264 = ['-c:v', 'libx264', '-crf', '16', '-preset', 'slow']

/**
 * raw.mkv's pieces in order, in seconds of the file: normal speed between the spans, each span at
 * its rate. `lead` is the file's seconds before the recorder's clock; an open span (`t1` null,
 * speedEnd never called) and the last piece run to the file's end (`end` null).
 */
export function segments(spans, lead) {
  const out = []
  let at = 0
  for (const s of spans.toSorted((a, b) => a.t0 - b.t0)) {
    if (s.t0 > at) out.push({ start: at + lead, end: s.t0 + lead, rate: 1 })
    const open = s.t1 === null || s.t1 === Infinity
    out.push({ start: s.t0 + lead, end: open ? null : s.t1 + lead, rate: s.rate })
    if (open) return out
    at = s.t1
  }
  out.push({ start: at + lead, end: null, rate: 1 })
  return out
}

export function screenFilter(pieces) {
  const n = pieces.length
  const split = `[0:v]split=${n}${pieces.map((_, i) => `[a${i}]`).join('')}`
  const trims = pieces.map(
    (p, i) =>
      `[a${i}]trim=start=${p.start.toFixed(4)}${p.end === null ? '' : `:end=${p.end.toFixed(4)}`},` +
      `setpts=(PTS-STARTPTS)/${p.rate}[s${i}]`
  )
  const join = `${pieces.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=1:a=0,fps=60,format=yuv420p[v]`
  return [split, ...trims, join].join(';')
}

function encodeScreen(takeDir, take, total) {
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-i',
      path.join(takeDir, 'raw.mkv'),
      '-filter_complex',
      screenFilter(segments(take.spans, take.lead)),
      '-map',
      '[v]',
      '-t',
      total.toFixed(3),
      ...X264,
      path.join(takeDir, 'take.mp4')
    ],
    { stdio: 'inherit' }
  )
  const frames = execFileSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-count_packets',
      '-show_entries',
      'stream=nb_read_packets',
      '-of',
      'csv=p=0',
      path.join(takeDir, 'take.mp4')
    ],
    { encoding: 'utf8' }
  )
  return Number(frames)
}

function encodeFrames(takeDir, total) {
  const frames = JSON.parse(fs.readFileSync(path.join(takeDir, 'frames.json'), 'utf8'))
  let list = ''
  for (let i = 0; i < frames.length; i++) {
    const end = i + 1 < frames.length ? frames[i + 1].t : Math.max(frames[i].t + 0.1, total)
    list += `file '${frames[i].f}'\nduration ${(end - Math.max(0, frames[i].t)).toFixed(4)}\n`
  }
  // concat ignores the last entry's duration unless its file is listed again.
  list += `file '${frames.at(-1).f}'\n`
  fs.writeFileSync(path.join(takeDir, 'concat.txt'), list)
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      path.join(takeDir, 'concat.txt'),
      '-t',
      total.toFixed(3),
      '-vf',
      'fps=60,format=yuv420p',
      ...X264,
      path.join(takeDir, 'take.mp4')
    ],
    { stdio: 'inherit' }
  )
  return frames.length
}

/** Encodes take.mp4 and returns its frame count (the screencast's: the frames it captured). */
export function encode(takeDir, total) {
  const take = JSON.parse(fs.readFileSync(path.join(takeDir, 'take.json'), 'utf8'))
  return take.backend === 'screen'
    ? encodeScreen(takeDir, take, total)
    : encodeFrames(takeDir, total)
}
