// Runs a tutorial's scenes.mjs against the running app and records it.
// Every scene starts its narration on a clock; `at(phrase)` waits for the word an action belongs to,
// so picture and voice stay in step. A silent film (narration.json `"silent": true`, the social
// clips) has no voice: each scene runs for its `dur` seconds and `at(seconds)` waits on the clock.
// Writes out/take/{frames,frames.json,events.json,timeline.json}.
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { connect } from './pw.mjs'
import { Recorder, installCursor, sleep } from './rec.mjs'

// Silence before and after each line; a scene can set its own `lead` and `tail` in narration.json
// (the title card needs time for the logo before the first word, the end card a hold after the last).
const LEAD = 0.5
const TAIL = 0.7

/** `page` films that page instead of the app (the social clips' terminal and diagram scenes). */
export async function record(dir, { page: given } = {}) {
  const N = JSON.parse(fs.readFileSync(path.join(dir, 'narration.json'), 'utf8'))
  const mod = await import(pathToFileURL(path.join(dir, 'scenes.mjs')).href)
  const missing = N.scenes.filter((s) => !mod.scenes[s.id]).map((s) => s.id)
  if (missing.length) throw new Error(`scenes.mjs has no scene for: ${missing.join(', ')}`)

  const { browser, page } = given ? { page: given } : await connect()
  const out = path.join(dir, 'out/take')
  const rec = new Recorder(page, out)
  const timeline = []
  let scene = null

  const ctx = {
    page,
    rec,
    sleep,
    L: (s) => page.locator(s),
    /** Wait until the narration reaches `phrase`, or until `phrase` seconds into the line (+ offset). */
    async at(phrase, offset = 0) {
      let t = phrase
      if (typeof phrase === 'string') {
        const i = scene.chars.indexOf(phrase)
        if (i < 0) throw new Error(`"${phrase}" is not in the narration of ${scene.id}`)
        t = scene.a.character_start_times_seconds[i]
      }
      const wait = scene.vo + t + offset - rec.now()
      if (wait > 0) await sleep(wait * 1000)
    },
    /** Wait out the rest of the line. Called for you if the scene does not. */
    async end() {
      if (scene.end) return
      const wait = scene.vo + scene.dur + scene.tail - rec.now()
      if (wait > 0) await sleep(wait * 1000)
      scene.end = rec.now()
    },
    zoom: (x, y, z) => rec.mark('zoom', { x, y, z }),
    unzoom: () => rec.mark('unzoom'),
    async zoomOn(locator, z, { dx = 0, dy = 0 } = {}) {
      const c = await rec.center(locator)
      rec.mark('zoom', { x: c.x + dx, y: c.y + dy, z })
    },
    /** Viewport position of the text caret, for zooming on what is being typed. */
    caret: () =>
      page.evaluate(() => {
        const r = getSelection().getRangeAt(0).getBoundingClientRect()
        return { x: r.x, y: r.y + r.height / 2 }
      })
  }

  await installCursor(page)
  await mod.setup?.(ctx)
  await rec.start()
  for (const s of N.scenes) {
    const a = N.silent
      ? null
      : JSON.parse(fs.readFileSync(path.join(dir, 'vo', `${s.id}.json`), 'utf8')).alignment
    scene = {
      id: s.id,
      t: rec.now(),
      vo: rec.now() + (s.lead ?? (N.silent ? 0 : LEAD)),
      tail: s.tail ?? (N.silent ? 0 : TAIL),
      dur: a ? a.character_end_times_seconds.at(-1) : s.dur,
      chars: a ? a.characters.join('') : '',
      a
    }
    rec.mark('scene', { id: s.id })
    timeline.push(scene)
    await mod.scenes[s.id](ctx)
    await ctx.end()
    if (mod.after?.[s.id]) await mod.after[s.id](ctx)
  }
  await rec.stop()
  const film = timeline.map(({ id, t, vo, dur, end }) => ({
    id,
    t: rec.remap(t),
    vo: rec.remap(vo),
    dur,
    end: rec.remap(end)
  }))
  fs.writeFileSync(path.join(out, 'timeline.json'), JSON.stringify(film, null, 1))
  await browser?.close()
  return film
}
