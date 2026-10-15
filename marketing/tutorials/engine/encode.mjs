// frames.json (variable-rate screencast) -> constant 60 fps mp4 through the concat demuxer.
// `-t` cuts at the take's end, since the repeated last entry would otherwise hold it twice.
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

export function encode(takeDir, total) {
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
      '-c:v',
      'libx264',
      '-crf',
      '16',
      '-preset',
      'slow',
      path.join(takeDir, 'take.mp4')
    ],
    { stdio: 'inherit' }
  )
  return frames.length
}
