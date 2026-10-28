// The write-back soak (Step 12e-3h, #3529): hours of edits made in the app and by other
// programs on one profile, with a quit and relaunch every half hour. 12e-3c merges only after a
// 12-hour run on the Windows VM passes (`writeback-soak-vm.ts`).
//
// Every step knows what each note must hold after it, from the invariants of the write-back
// (`crates/memry-desktop/src/vault/writeback/mod.rs`) and the feed
// (`crates/memry-desktop/src/vault/consumer/mod.rs`), never "either may win":
//
// - An edit made in the app reaches the file: the pass writes a body that differs from a file
//   its row still describes.
// - A later outside save wins: it lands before the pass (the pass keeps the changed file and
//   the feed brings its text into the body) or after it (the feed does). The app's edit is kept
//   as a version, which this soak does not read.
// - A save of the bytes the row already holds is no edit: the feed skips it, so an app edit
//   still waiting for its pass reaches the file.
// - A pass for a note whose file already says its body writes nothing: no new bytes, no new
//   modified time (Step 17 schedules every note of a pulled page).
// - A quit writes what was scheduled before it, on every way the app quits.
// - Nothing rewrites a file nobody edited, across steps and relaunches.
//
// After each step every note is read twice, 3 s apart: the touched note must hold its
// expected text in both file and body, and every other note must be exactly as before the
// step, bytes and modified time. Any failure names the seed, the round and the step; the same
// seed replays the same steps.
import type { Executor } from '../harness/invoke-test'
import { invokeTest } from '../harness/invoke-test'

/** How the soak reaches the app. */
export interface SoakDriver {
  executor(): Executor
  /** After the app quit: fails unless it exited, then starts it on the same profile and vault. */
  relaunch(): Promise<void>
}

export type Quit = 'request-quit' | 'session-end'

export interface SoakOptions {
  hours: number
  notes: number
  seed: number
  /** Cycled through by the quit steps; `session-end` is Windows only. */
  quits: Quit[]
  quitEveryMs: number
  checkEveryMs: number
}

export interface SoakReport {
  rounds: number
  steps: Record<Step, number>
}

const STEPS = [
  'app-edit',
  'app-burst',
  'outside-write',
  'outside-atomic-save',
  'race',
  'same-bytes-save',
  'schedule-unchanged',
  'quit'
] as const
type Step = (typeof STEPS)[number]

const SETTLE_MS = 20_000
const STABLE_MS = 3_000
/** The write-back's debounce (`DEBOUNCE` of `writeback/schedule.rs`). */
const DEBOUNCE_MS = 500
/** Longer than the debounce plus the longest cooldown (`MAX_COOLDOWN`, 5 s). */
const PASS_DUE_MS = 6_000
const REOPEN_MS = 60_000

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

/** SOAK_HOURS (12), SOAK_NOTES (20), SOAK_SEED (now), SOAK_QUIT_EVERY_MIN (30). */
export function optionsFromEnv(env: NodeJS.ProcessEnv, quits: Quit[]): SoakOptions {
  return {
    hours: Number(env.SOAK_HOURS ?? 12),
    notes: Number(env.SOAK_NOTES ?? 20),
    seed: Number(env.SOAK_SEED ?? Date.now()),
    quits,
    quitEveryMs: Number(env.SOAK_QUIT_EVERY_MIN ?? 30) * 60_000,
    checkEveryMs: 10 * 60_000
  }
}

function validate(options: SoakOptions): void {
  const bad: string[] = []
  if (!Number.isFinite(options.hours) || options.hours <= 0) bad.push(`hours ${options.hours}`)
  if (!Number.isInteger(options.notes) || options.notes < 1) bad.push(`notes ${options.notes}`)
  if (!Number.isSafeInteger(options.seed)) bad.push(`seed ${options.seed}`)
  if (options.quits.length === 0) bad.push('no way to quit')
  if (!Number.isFinite(options.quitEveryMs) || options.quitEveryMs <= 0) {
    bad.push(`quit every ${options.quitEveryMs} ms`)
  }
  if (bad.length > 0) throw new Error(`soak: bad options: ${bad.join(', ')}`)
}

interface NoteFile {
  noteId: string
  path: string
  contentHash: string | null
}

interface VaultFile {
  text: string
  contentHash: string
  mtimeMs: number
  size: number
}

/** One note as read: its file, its row's hash and its body. */
interface Seen {
  file: VaultFile | null
  hash: string | null
  body: string
}

export async function soak(driver: SoakDriver, options: SoakOptions): Promise<SoakReport> {
  validate(options)
  const { seed } = options
  const next = random(seed)
  const call = <T>(name: string, args: Record<string, unknown> = {}): Promise<T> =>
    invokeTest<T>({ executor: driver.executor() }, name, args)
  const log = (event: string, extra: Record<string, unknown> = {}): void =>
    console.log(JSON.stringify({ at: new Date().toISOString(), event, seed, ...extra }))
  let round = 0
  let step: Step | 'adopt' | 'check' = 'adopt'
  const fail = (message: string): never => {
    throw new Error(`soak seed=${seed} round=${round} step=${step}: ${message}`)
  }
  const show = (value: unknown): string => JSON.stringify(value)

  async function until<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + SETTLE_MS
    for (;;) {
      const value = await probe()
      if (value !== undefined) return value
      if (Date.now() > deadline) return fail(`never ${what}`)
      await sleep(200)
    }
  }
  const rows = (): Promise<NoteFile[]> => call('e2e_vault_note_files')
  const read = (path: string): Promise<VaultFile | null> => call('e2e_vault_read_file', { path })
  const body = (noteId: string): Promise<string> => call('e2e_note_body', { noteId })
  const edit = (noteId: string, text: string): Promise<void> =>
    call('e2e_note_edit', { noteId, text })
  const save = (path: string, text: string, replace: boolean): Promise<void> =>
    call('e2e_vault_write_outside', { path, text, replace })

  async function snapshot(notes: NoteFile[]): Promise<Map<string, Seen>> {
    const hashes = new Map((await rows()).map((row) => [row.noteId, row.contentHash]))
    const seen = new Map<string, Seen>()
    for (const note of notes) {
      seen.set(note.noteId, {
        file: await read(note.path),
        hash: hashes.get(note.noteId) ?? null,
        body: await body(note.noteId)
      })
    }
    return seen
  }

  /** The note's file and body both say `text`, and its row describes that file. */
  const holds = (seen: Seen | undefined, text: string): boolean =>
    seen?.file?.text === `${text}\n` && seen.body === text && seen.hash === seen.file.contentHash
  const same = (a: Seen | undefined, b: Seen | undefined): boolean =>
    a !== undefined &&
    b !== undefined &&
    a.hash === b.hash &&
    a.body === b.body &&
    a.file?.text === b.file?.text &&
    a.file?.size === b.file?.size &&
    a.file?.mtimeMs === b.file?.mtimeMs

  log('start', { ...options })
  await call('e2e_vault_adopt_files')
  const notes: NoteFile[] = []
  const expected = new Map<string, string>()
  for (let i = 0; i < options.notes; i += 1) {
    const path = `soak/n${i}.md`
    await save(path, `n${i} start\n`, false)
    const note = await until(`${path} became a note`, async () =>
      (await rows()).find((row) => row.path === path && row.contentHash !== null)
    )
    notes.push(note)
    expected.set(note.noteId, `n${i} start`)
  }
  for (const note of notes) {
    const want = expected.get(note.noteId) as string
    await until(`${note.path} held ${show(want)}`, async () =>
      holds((await snapshot([note])).get(note.noteId), want) ? true : undefined
    )
  }

  /** Every note as `expected` says, in file and body. */
  async function checkAll(): Promise<void> {
    const seen = await snapshot(notes)
    for (const note of notes) {
      const want = expected.get(note.noteId) as string
      if (!holds(seen.get(note.noteId), want)) {
        fail(`${note.path} is ${show(seen.get(note.noteId))}, expected ${show(want)}`)
      }
    }
  }

  async function reopened(): Promise<void> {
    const deadline = Date.now() + REOPEN_MS
    for (;;) {
      try {
        const listed = await rows()
        if (notes.every((note) => listed.some((row) => row.noteId === note.noteId))) return
      } catch {
        // The renderer or the vault is not up yet.
      }
      if (Date.now() > deadline) fail('the vault did not open again after the relaunch')
      await sleep(500)
    }
  }

  const start = Date.now()
  const end = start + options.hours * 3_600_000
  let nextQuit = start + Math.min(options.quitEveryMs, (end - start) / 2)
  let nextCheck = start + options.checkEveryMs
  let quitCount = 0
  const steps = Object.fromEntries(STEPS.map((kind) => [kind, 0])) as Record<Step, number>
  const others = STEPS.filter((kind) => kind !== 'quit')

  while (Date.now() < end) {
    round += 1
    // The first rounds take every step once, so a short run covers them all.
    step =
      Date.now() >= nextQuit
        ? 'quit'
        : round <= others.length
          ? others[round - 1]
          : others[Math.floor(next() * others.length)]
    const note = notes[Math.floor(next() * notes.length)]
    const tag = `r${round}`
    const before = await snapshot(notes)
    let touched: string | null = note.noteId
    let want = ''

    switch (step) {
      case 'app-edit':
        want = `${tag} typed in the app`
        await edit(note.noteId, want)
        break
      case 'app-burst':
        for (let k = 0; k < 5; k += 1) {
          want = `${tag} typed ${k}`
          await edit(note.noteId, want)
          await sleep(Math.floor(next() * 150))
        }
        break
      case 'outside-write':
        want = `${tag} saved by another program`
        await save(note.path, `${want}\n`, false)
        break
      case 'outside-atomic-save':
        want = `${tag} saved atomically`
        await save(note.path, `${want}\n`, true)
        break
      case 'race': {
        // The outside save lands around the debounce: before the pass, during it or after it.
        await edit(note.noteId, `${tag} typed in the app`)
        await sleep(Math.max(0, Math.round(DEBOUNCE_MS + (next() + next() - 1) * 350)))
        want = `${tag} saved by another program`
        await save(note.path, `${want}\n`, next() < 0.5)
        break
      }
      case 'same-bytes-save': {
        // Saved again unchanged while the edit waits for its pass, well inside the debounce.
        const bytes = before.get(note.noteId)?.file?.text ?? fail(`${note.path} is missing`)
        want = `${tag} typed in the app`
        await edit(note.noteId, want)
        await save(note.path, bytes, next() < 0.5)
        break
      }
      case 'schedule-unchanged': {
        touched = null
        const chosen = notes.filter(() => next() < 0.3).map((each) => each.noteId)
        await call('e2e_note_schedule', { noteIds: chosen.length > 0 ? chosen : [note.noteId] })
        await sleep(PASS_DUE_MS)
        break
      }
      case 'quit': {
        const quit = options.quits[quitCount % options.quits.length]
        quitCount += 1
        want = `${tag} typed before the ${quit}`
        await edit(note.noteId, want)
        // The app may be gone before the reply.
        await (
          quit === 'request-quit'
            ? call('e2e_request_quit')
            : call('e2e_send_session_end', { target: 'main', killWebview: true })
        ).catch(() => undefined)
        await driver.relaunch()
        await reopened()
        nextQuit = Date.now() + options.quitEveryMs
        log('relaunched', { round, quit })
        break
      }
    }

    if (touched !== null) {
      const id = touched
      await until(`${note.path} held ${show(want)}`, async () =>
        holds((await snapshot([note])).get(id), want) ? true : undefined
      )
      expected.set(id, want)
    }
    const after = await snapshot(notes)
    await sleep(STABLE_MS)
    const again = await snapshot(notes)
    for (const each of notes) {
      const id = each.noteId
      if (id === touched) {
        if (!same(after.get(id), again.get(id))) {
          fail(
            `${each.path} changed after it settled: ${show(after.get(id))} -> ${show(again.get(id))}`
          )
        }
      } else if (!same(before.get(id), again.get(id))) {
        fail(`${each.path}, not edited, changed: ${show(before.get(id))} -> ${show(again.get(id))}`)
      }
    }
    steps[step] += 1

    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + options.checkEveryMs
      const kind = step
      step = 'check'
      await checkAll()
      step = kind
      log('check', { round, steps, leftMin: Math.round((end - Date.now()) / 60_000) })
    }
  }
  step = 'check'
  await checkAll()
  if (round === 0) fail('no round ran')
  const missing = STEPS.filter((kind) => steps[kind] === 0)
  if (missing.length > 0) fail(`never took ${missing.join(', ')}`)
  log('soak passed', { rounds: round, steps })
  return { rounds: round, steps }
}
