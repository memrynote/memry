// narration.json -> out/takes/<id>-<n>.{mp3,json}, Scribe-scored, best take copied to vo/<id>.*
// A take is reused while its text and voice settings match, so reruns cost no credits.
// narration.json can pin a take per scene with "take": n.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { speak, transcribe, wer } from './eleven.mjs'

export async function narrate(dir, { takes = 2, only = [] } = {}) {
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const takesDir = path.join(dir, 'out/takes')
  fs.mkdirSync(takesDir, { recursive: true })
  fs.mkdirSync(path.join(dir, 'vo'), { recursive: true })
  const report = {}
  for (const s of N.scenes) {
    if (only.length && !only.includes(s.id)) continue
    const text = s.text.replaceAll('{brand}', N.brand)
    const hash = createHash('sha1')
      .update(JSON.stringify([text, N.voice, N.model, N.settings]))
      .digest('hex')
      .slice(0, 12)
    const scored = []
    for (let k = 1; k <= takes; k++) {
      const base = path.join(takesDir, `${s.id}-${k}`)
      let meta = fs.existsSync(base + '.json')
        ? JSON.parse(fs.readFileSync(base + '.json', 'utf8'))
        : null
      if (meta?.hash !== hash) {
        const { mp3, alignment } = await speak({
          voice: N.voice,
          model: N.model,
          settings: N.settings,
          text
        })
        fs.writeFileSync(base + '.mp3', mp3)
        meta = { hash, text, alignment }
        console.log(`  tts ${s.id}-${k}`)
      }
      if (meta.wer === undefined) {
        meta.heard = await transcribe(base + '.mp3')
        meta.wer = Number(wer(text, meta.heard).toFixed(3))
      }
      fs.writeFileSync(base + '.json', JSON.stringify(meta))
      scored.push({
        k,
        wer: meta.wer,
        dur: meta.alignment.character_end_times_seconds.at(-1),
        heard: meta.heard
      })
    }
    const pick = s.take
      ? scored.find((t) => t.k === s.take)
      : [...scored].sort((a, b) => a.wer - b.wer || a.k - b.k)[0]
    const from = path.join(takesDir, `${s.id}-${pick.k}`)
    fs.copyFileSync(from + '.mp3', path.join(dir, 'vo', `${s.id}.mp3`))
    const { alignment } = JSON.parse(fs.readFileSync(from + '.json', 'utf8'))
    fs.writeFileSync(
      path.join(dir, 'vo', `${s.id}.json`),
      JSON.stringify({ take: pick.k, hash, text, alignment })
    )
    report[s.id] = { picked: pick.k, takes: scored }
    console.log(`  ${s.id}: take ${pick.k}, wer ${pick.wer}, ${pick.dur.toFixed(1)}s`)
  }
  fs.writeFileSync(path.join(dir, 'out/takes.json'), JSON.stringify(report, null, 1))
  return report
}
