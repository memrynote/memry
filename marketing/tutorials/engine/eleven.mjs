// ElevenLabs over REST: speech with character timings, and Scribe transcription for QA.
// The key lives in marketing/.env (gitignored) and is never printed.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const ENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env')

function key() {
  const m = fs.existsSync(ENV) && fs.readFileSync(ENV, 'utf8').match(/^ELEVENLABS_API_KEY=(.+)$/m)
  if (!m) throw new Error(`ELEVENLABS_API_KEY missing from ${ENV}`)
  return m[1].trim().replace(/^["']|["']$/g, '')
}

async function call(p, init = {}) {
  const r = await fetch('https://api.elevenlabs.io' + p, {
    ...init,
    headers: { 'xi-api-key': key(), ...init.headers }
  })
  const body = await r.text()
  if (!r.ok) throw new Error(`ElevenLabs ${p} -> ${r.status} ${body.slice(0, 300)}`)
  return JSON.parse(body)
}

/** -> { mp3: Buffer, alignment: { characters, character_start_times_seconds, character_end_times_seconds } } */
export async function speak({ voice, model, settings, text }) {
  const j = await call(`/v1/text-to-speech/${voice}/with-timestamps?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, voice_settings: settings })
  })
  return { mp3: Buffer.from(j.audio_base64, 'base64'), alignment: j.alignment }
}

export async function transcribe(file) {
  const fd = new FormData()
  fd.append('model_id', 'scribe_v1')
  fd.append('language_code', 'en')
  fd.append('tag_audio_events', 'false')
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file))
  return (await call('/v1/speech-to-text', { method: 'POST', body: fd })).text
}

export async function quota() {
  const u = await call('/v1/user/subscription')
  return { tier: u.tier, used: u.character_count, limit: u.character_limit }
}

/** Word error rate of `heard` against `said`, brand spellings folded together. */
export function wer(said, heard) {
  const norm = (s) =>
    s
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/memree note|memory ?note|memry ?note/g, 'memrynote')
      .replace(/end-to-end/g, 'end to end')
      .replace(/[^a-z0-9' ]/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
  const a = norm(said)
  const b = norm(heard)
  const d = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0]
    d[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j]
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] !== b[j - 1] ? 1 : 0))
      prev = cur
    }
  }
  return d[b.length] / Math.max(1, a.length)
}
