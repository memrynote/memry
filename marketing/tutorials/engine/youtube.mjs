// YouTube metadata for a topic's film, from narration.json's `youtube` block, ../channel.json,
// the playlist's ID in ../youtube-ids.json, out/<topic>.chapters.txt and out/qa.json:
//   out/<topic>.youtube.json      the videos.insert body (snippet and status)
//   out/<topic>.description.txt   the same description, to paste into Studio
// It fails on anything YouTube would reject or silently drop, naming the field and the limit.
//
//   node marketing/tutorials/engine/build.mjs <topic> --only youtube
//
// Limits: the Data API's videos resource (title 100 characters, description 5000 bytes, tags
// 500 characters, no < or >) and YouTube Help's chapter rules (the first at 0:00, at least
// three, each 10 s or longer). channel.json's categoryId 28 is Science & Technology, the
// category both benchmark channels use.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const TUTORIALS = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))

export const IDS = path.join(TUTORIALS, 'youtube-ids.json')
/** What publish.mjs created on YouTube: playlist IDs by channel.json key, video IDs by topic. */
export const readIds = () => (fs.existsSync(IDS) ? read(IDS) : { playlists: {}, videos: {} })

/** Seconds in a chapter stamp: "1:02" or "1:02:03". */
const seconds = (stamp) => stamp.split(':').reduce((s, part) => s * 60 + Number(part), 0)

export function buildMetadata(dir) {
  const topic = path.basename(dir)
  const C = read(path.join(TUTORIALS, 'channel.json'))
  const Y = read(path.join(dir, 'narration.json')).youtube
  if (!Y) throw new Error(`${dir}/narration.json has no "youtube" block`)
  const chaptersFile = path.join(dir, `out/${topic}.chapters.txt`)
  const qaFile = path.join(dir, 'out/qa.json')
  for (const file of [chaptersFile, qaFile])
    if (!fs.existsSync(file)) throw new Error(`Missing ${file}. Run the build first.`)

  const errors = []
  const warnings = []

  const duration = read(qaFile).duration
  const chapters = fs
    .readFileSync(chaptersFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\d+(?::\d{2}){1,2}) (.+)$/)
      if (!m) throw new Error(`${chaptersFile}: cannot read the chapter line "${line}"`)
      return { line, stamp: m[1], t: seconds(m[1]), title: m[2] }
    })
  if (chapters[0].t !== 0) errors.push('chapters: the first one has to start at 0:00')
  if (chapters.length < 3)
    errors.push(`chapters: ${chapters.length} found, and YouTube needs at least 3`)
  chapters.forEach((c, i) => {
    const length = (chapters[i + 1]?.t ?? duration) - c.t
    if (length < 10)
      errors.push(
        `chapters: "${c.title}" at ${c.stamp} runs ${Math.round(length)} s, and each needs 10 s or more`
      )
  })

  const title = (Y.title ?? '').trim()
  const titleChars = [...title].length
  if (!titleChars) errors.push('youtube.title: missing')
  if (titleChars > 100)
    errors.push(`youtube.title: ${titleChars} characters, over the limit of 100`)
  if (/[<>]/.test(title)) errors.push('youtube.title: contains < or >, which YouTube rejects')
  if (titleChars > 70)
    warnings.push(
      `youtube.title: ${titleChars} characters, and about 70 show before YouTube cuts it`
    )
  const brandAt = title.toLowerCase().indexOf('memrynote')
  if (brandAt >= 0 && brandAt + 'memrynote'.length < title.length - 1)
    warnings.push('youtube.title: put memrynote last or leave it out, since nobody searches it yet')

  if (!Y.summary) errors.push('youtube.summary: missing')
  if (Y.next && !Y.next.url)
    errors.push('youtube.next: needs a url, so name the next video only once it is published')
  const playlist = C.playlists[Y.playlist]
  const playlistId = readIds().playlists[Y.playlist]
  if (!playlist)
    errors.push(
      `youtube.playlist: "${Y.playlist}" is not one of channel.json's playlists (${Object.keys(C.playlists).join(', ')})`
    )
  else if (!playlistId)
    warnings.push(
      `the ${playlist.title} playlist is not on YouTube yet, so the description leaves its link out`
    )

  const download = new URL(C.download)
  download.search = new URLSearchParams({
    utm_source: 'youtube',
    utm_medium: 'video',
    utm_campaign: topic
  }).toString()
  const description = [
    Y.summary,
    chapters.map((c) => c.line).join('\n'),
    (Y.notYet ?? []).map((line) => `Not yet: ${line}`).join('\n'),
    [Y.docs && `Docs: ${new URL(Y.docs, C.docs)}`, `Download memrynote: ${download}`, C.feedback]
      .filter(Boolean)
      .join('\n'),
    [
      Y.next && `Next: ${Y.next.title} ${Y.next.url}`,
      playlistId && `${playlist.title}: https://www.youtube.com/playlist?list=${playlistId}`
    ]
      .filter(Boolean)
      .join('\n'),
    C.footer
  ]
    .filter(Boolean)
    .join('\n\n')
  const bytes = Buffer.byteLength(description, 'utf8')
  if (bytes > 5000) errors.push(`description: ${bytes} bytes, over the limit of 5000`)
  if (/[<>]/.test(description)) errors.push('description: contains < or >, which YouTube rejects')

  // The API counts the commas between tags, and the quotes around a tag that has a space.
  const tags = []
  for (const tag of [...C.tags, ...(Y.tags ?? [])])
    if (!tags.some((t) => t.toLowerCase() === tag.toLowerCase())) tags.push(tag)
  const tagChars =
    tags.reduce((n, t) => n + t.length + (t.includes(' ') ? 2 : 0), 0) +
    Math.max(0, tags.length - 1)
  if (tagChars > 500)
    errors.push(`tags: ${tagChars} characters as YouTube counts them, over the limit of 500`)

  if (errors.length)
    throw new Error(`YouTube would reject or drop this metadata:\n  ${errors.join('\n  ')}`)
  const out = path.join(dir, 'out')
  const body = { snippet: { title, description, tags, ...C.snippet }, status: C.status }
  fs.writeFileSync(path.join(out, `${topic}.youtube.json`), `${JSON.stringify(body, null, 2)}\n`)
  fs.writeFileSync(path.join(out, `${topic}.description.txt`), `${description}\n`)
  return { titleChars, bytes, tagChars, chapters: chapters.length, warnings }
}
