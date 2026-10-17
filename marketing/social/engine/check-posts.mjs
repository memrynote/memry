#!/usr/bin/env node
// Checks the series file against what X's scheduler and the plan require:
//   node marketing/social/engine/check-posts.mjs [marketing/social/2026-q4.md]
// - every X post fits 280 weighted characters (X counts a URL as 23 and most non-Latin as 2);
// - no @ or # in X copy (X would turn them into mentions and hashtags), no links in the body;
// - one X post per day from the first day to the last, each with media;
// - Reddit posts fall on Tue, Thu and Sat only;
// - every clip a post names is in the Clips table.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../2026-q4.md')
)
const lines = fs.readFileSync(file, 'utf8').split('\n')
const YEAR = 2026
const MONTHS = { Oct: 9, Nov: 10, Dec: 11, Jan: 0 }

// twitter-text v3: code points in these ranges weigh 1, everything else 2; URLs weigh 23.
const LIGHT = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247]
]
const URL =
  /\b(?:https?:\/\/)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|app|dev|co|so|md)\b\S*/gi
function weighted(text) {
  let n = 0
  const rest = text.replace(URL, () => {
    n += 23
    return ''
  })
  for (const ch of rest) {
    const cp = ch.codePointAt(0)
    n += LIGHT.some(([a, b]) => cp >= a && cp <= b) ? 1 : 2
  }
  return n
}

const clips = new Set()
let inClips = false
for (const l of lines) {
  if (l.startsWith('## ')) inClips = l === '## Clips'
  if (inClips) for (const m of l.matchAll(/^\| `([a-z0-9-]+)`/g)) clips.add(m[1])
}

const problems = []
const warnings = []
const days = []
let day = null
for (let i = 0; i < lines.length; i++) {
  const l = lines[i]
  const h = l.match(/^### (Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Oct|Nov|Dec|Jan) (\d+)/)
  if (h) {
    const d = new Date(Date.UTC(h[2] === 'Jan' ? YEAR + 1 : YEAR, MONTHS[h[2]], Number(h[3])))
    const real = d.toUTCString().slice(0, 3)
    if (real !== h[1]) problems.push(`${l}: that date is a ${real}`)
    day = { label: l.slice(4), date: d, x: null, reddit: false }
    days.push(day)
    continue
  }
  if (!day) continue
  if (l.startsWith('## ')) day = null
  if (!day) continue
  const isX = l.startsWith('**X**')
  const isReddit = l.startsWith('**r/MemryNote**')
  if (isReddit) day.reddit = true
  if (!isX) continue
  if (day.x) problems.push(`${day.label}: two X posts`)
  const media = l.match(/(🎬|🖼️|🧩) `([a-z0-9-]+)`/)
  if (!media) problems.push(`${day.label}: X post without media`)
  else if (!clips.has(media[2]) && !/^week-\d+$/.test(media[2]))
    problems.push(`${day.label}: clip "${media[2]}" is not in the Clips table`)
  // The post is the blockquote that follows.
  let j = i + 1
  while (lines[j] === '') j++
  const quote = []
  while (lines[j]?.startsWith('>')) quote.push(lines[j++].replace(/^> ?/, ''))
  const text = quote.join('\n').trim()
  if (!text) problems.push(`${day.label}: X post has no text`)
  const n = weighted(text)
  day.x = { text, n }
  if (n > 280) problems.push(`${day.label}: ${n}/280 characters`)
  if (/[@#]/.test(text)) problems.push(`${day.label}: @ or # in X copy`)
  if (text.match(URL)) problems.push(`${day.label}: a link in the X post (${text.match(URL)})`)
  if (/\[[^\]]+\]/.test(text)) warnings.push(`${day.label}: placeholder left to fill`)
}

// One post per day, no gaps.
const dated = days.filter((d) => d.date)
for (let k = 1; k < dated.length; k++) {
  const gap = (dated[k].date - dated[k - 1].date) / 864e5
  if (gap !== 1) problems.push(`${dated[k - 1].label} → ${dated[k].label}: ${gap} days apart`)
}
for (const d of dated) if (!d.x) problems.push(`${d.label}: no X post`)
const badReddit = dated.filter(
  (d) => d.reddit && !['Tue', 'Thu', 'Sat'].includes(d.label.slice(0, 3))
)
for (const d of badReddit) problems.push(`${d.label}: Reddit post off Tue/Thu/Sat`)
const missingReddit = dated.filter(
  (d) => !d.reddit && ['Tue', 'Thu', 'Sat'].includes(d.label.slice(0, 3))
)
for (const d of missingReddit) problems.push(`${d.label}: Tue/Thu/Sat without a Reddit post`)

const lengths = dated.map((d) => d.x?.n ?? 0)
console.log(
  `${dated.length} days (${dated[0]?.label} → ${dated.at(-1)?.label}), ` +
    `${dated.filter((d) => d.reddit).length} Reddit posts, ${clips.size} clips in the table, ` +
    `X length ${Math.min(...lengths)}–${Math.max(...lengths)}`
)
for (const w of warnings) console.log(`  warning: ${w}`)
if (problems.length) {
  console.error(`${problems.length} problem(s):\n  - ${problems.join('\n  - ')}`)
  process.exit(1)
}
console.log('ok')
