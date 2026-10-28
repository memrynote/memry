// The write-back soak (Step 12e-3h, #3529): hours of edits made in the app and by other
// programs on one running app, which must never lose an edit, leave a file and its note apart,
// or keep rewriting a file nobody changed. 12e-3c merges only after a 12-hour run on the
// Windows VM passes.
//
//   winvm.sh install-artifact <run-id> && winvm.sh launch-tauri
//   SOAK_HOURS=12 winvm.sh cdp run e2e/soak/writeback-soak.ts
//
// SOAK_HOURS (default 12), SOAK_NOTES (default 20) and SOAK_SEED (default the start time, printed)
// shape a run; the same seed replays the same steps. It prints a JSON line per check and ends
// with `soak passed` or throws at the first broken rule, naming the note, the step and both
// texts. Afterwards `winvm.sh logs` must show no `the write-back failed`.
import type { Executor } from '../harness/invoke-test'
import { invokeTest } from '../harness/invoke-test'

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

const SETTLE_MS = 20_000
const CHECK_EVERY_MS = 10 * 60_000

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

/** mulberry32: a small seeded generator, so a failing run replays. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

export default async function soak({ browser }: { browser: Executor }): Promise<void> {
  const hours = Number(process.env.SOAK_HOURS ?? 12)
  const count = Number(process.env.SOAK_NOTES ?? 20)
  const seed = Number(process.env.SOAK_SEED ?? Date.now())
  const next = random(seed)
  const app = { executor: browser }
  const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
    invokeTest<T>(app, name, args)
  const log = (event: string, extra: Record<string, unknown> = {}): void =>
    console.log(JSON.stringify({ at: new Date().toISOString(), event, ...extra }))

  async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + SETTLE_MS
    for (;;) {
      const value = await probe()
      if (value !== undefined) return value
      if (Date.now() > deadline) throw new Error(`soak: never ${what}`)
      await sleep(200)
    }
  }
  const file = (path: string): Promise<string | null> => call('e2e_vault_read_file', { path })
  const body = (noteId: string): Promise<string> => call('e2e_note_body', { noteId })
  const rows = (): Promise<NoteFile[]> => call('e2e_vault_note_files')

  /** The note's file holds `text` and its body the same, and stays so while nobody edits. */
  async function settled(note: NoteFile, text: string, step: string): Promise<void> {
    await until(`${step}: ${note.path} settled on ${JSON.stringify(text)}`, async () => {
      const [onDisk, inNote] = [await file(note.path), await body(note.noteId)]
      return onDisk === `${text}\n` && inNote === text ? true : undefined
    })
    const hash = (await rows()).find((row) => row.noteId === note.noteId)?.contentHash
    await sleep(3_000)
    const [onDisk, again] = [
      await file(note.path),
      (await rows()).find((row) => row.noteId === note.noteId)?.contentHash
    ]
    if (onDisk !== `${text}\n` || again !== hash) {
      throw new Error(
        `soak: ${step}: ${note.path} changed with nobody editing: ${JSON.stringify(onDisk)}`
      )
    }
  }

  log('start', { hours, notes: count, seed })
  await call('e2e_vault_adopt_files')
  const notes: NoteFile[] = []
  for (let i = 0; i < count; i += 1) {
    const path = `soak/n${i}.md`
    await call('e2e_vault_write_outside', { path, text: `n${i} start\n`, replace: false })
    notes.push(
      await until(`${path} became a note`, async () =>
        (await rows()).find((row) => row.path === path && row.contentHash !== null)
      )
    )
  }
  for (const note of notes) await settled(note, `${note.path.slice(5, -3)} start`, 'adopt')

  const end = Date.now() + hours * 3_600_000
  let round = 0
  let lastCheck = Date.now()
  const steps: Record<string, number> = {}
  while (Date.now() < end) {
    round += 1
    const note = notes[Math.floor(next() * notes.length)]
    const roll = next()
    const tag = `r${round}`
    let step: string
    let want: string
    if (roll < 0.35) {
      step = 'app-edit'
      want = `${tag} typed in the app`
      await call('e2e_note_edit', { noteId: note.noteId, text: want })
    } else if (roll < 0.55) {
      step = 'app-burst'
      for (let k = 0; k < 5; k += 1) {
        want = `${tag} typed ${k}`
        await call('e2e_note_edit', { noteId: note.noteId, text: want })
        await sleep(Math.floor(next() * 150))
      }
      want = `${tag} typed 4`
    } else if (roll < 0.75) {
      step = 'outside-write'
      want = `${tag} saved by another program`
      await call('e2e_vault_write_outside', { path: note.path, text: `${want}\n`, replace: false })
    } else if (roll < 0.9) {
      step = 'outside-atomic-save'
      want = `${tag} saved atomically`
      await call('e2e_vault_write_outside', { path: note.path, text: `${want}\n`, replace: true })
    } else {
      // An app edit and an outside save at once: either may win, but the two must agree.
      step = 'race'
      await call('e2e_note_edit', { noteId: note.noteId, text: `${tag} app side` })
      await sleep(Math.floor(next() * 600))
      await call('e2e_vault_write_outside', {
        path: note.path,
        text: `${tag} outside side\n`,
        replace: next() < 0.5
      })
      want = await until(`${step}: ${note.path} agreed`, async () => {
        const [onDisk, inNote] = [await file(note.path), await body(note.noteId)]
        return onDisk !== null && onDisk === `${inNote}\n` && inNote.startsWith(tag)
          ? inNote
          : undefined
      })
    }
    await settled(note, want, step)
    steps[step] = (steps[step] ?? 0) + 1

    if (Date.now() - lastCheck > CHECK_EVERY_MS) {
      lastCheck = Date.now()
      for (const each of notes) {
        const [onDisk, inNote] = [await file(each.path), await body(each.noteId)]
        if (onDisk !== `${inNote}\n`) {
          throw new Error(
            `soak: check: ${each.path} ${JSON.stringify(onDisk)} != body ${JSON.stringify(inNote)}`
          )
        }
      }
      log('check', { round, steps, left_min: Math.round((end - Date.now()) / 60_000) })
    }
  }
  log('soak passed', { rounds: round, steps, seed })
}
