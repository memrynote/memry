#!/usr/bin/env node
/**
 * Approve clips after looking at their QA stills: copy clips/<slug>/out/<slug>.{mp4,png} into
 * media/ (tracked in git), then rebuild CHECKLIST.md and the kit.
 *
 *   node marketing/social/engine/approve.mjs <slug>...
 *
 * Refuses a film that isn't the series format: 1920x1080, 60 fps, H.264, no audio.
 */
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENGINE = path.dirname(fileURLToPath(import.meta.url))
const SOCIAL = path.dirname(ENGINE)
const MEDIA = path.join(SOCIAL, 'media')
const slugs = process.argv.slice(2)
if (!slugs.length) throw new Error('Usage: approve.mjs <slug>...')

const probe = (f, args) =>
  execFileSync('ffprobe', ['-v', 'error', ...args, '-of', 'csv=p=0', f], {
    encoding: 'utf8'
  }).trim()
fs.mkdirSync(MEDIA, { recursive: true })
for (const slug of slugs) {
  const out = path.join(SOCIAL, 'clips', slug, 'out')
  const film = path.join(out, `${slug}.mp4`)
  if (!fs.existsSync(film)) throw new Error(`${slug}: no film at ${film}`)
  const video = probe(film, [
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=codec_name,width,height,r_frame_rate'
  ])
  const audio = probe(film, ['-select_streams', 'a', '-show_entries', 'stream=index'])
  if (video !== 'h264,1920,1080,60/1' || audio)
    throw new Error(
      `${slug}: ${video}, audio "${audio}"; expected h264,1920,1080,60/1 and no audio`
    )
  for (const ext of ['mp4', 'png'])
    fs.copyFileSync(path.join(out, `${slug}.${ext}`), path.join(MEDIA, `${slug}.${ext}`))
  console.log(`approved ${slug}`)
}
execFileSync('node', [path.join(ENGINE, 'export-kit.mjs')], { stdio: 'inherit' })
