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
// - A later outside save lands after the pass and wins: the feed brings its text into the
//   body. One that lands while the app's edit still waits for its pass meets a body ahead of
//   its file: the body wins and the outside file is kept as a version
//   (`vault/consumer/body.rs`, Step 14), which the soak reads back. Either way no text is lost.
// - A save of the bytes the row already holds is no edit: the feed skips it, so an app edit
//   still waiting for its pass reaches the file.
// - A pass for a note whose file already says its body writes nothing: no new bytes, no new
//   modified time (Step 17 schedules every note of a pulled page).
// - A quit writes what was scheduled before it, on every way the app quits.
// - Nothing rewrites a file nobody edited, across steps and relaunches.
// - A rename or a move (`notes_rename`, `notes_move`, Step 13) carries the file's bytes to the
//   new path and leaves nothing at the old one, also while an app edit waits for its pass or an
//   outside save is still on its way to the feed: that text reaches the file at the new path.
// - No file appears that no note was made for: the soak folder holds exactly its notes.
//
// After each step every note is read twice, 3 s apart: the touched note must hold its
// expected text in both file and body, and every other note must be exactly as before the
// step, bytes and modified time. The soak fails only for those rules: a call the harness can
// retry is retried, and a same-bytes save that came too late to prove its rule is counted as
// inconclusive (at least one must be conclusive). Each round prints one JSON line. A failure
// names the seed, the round, the step and the last rounds; the same seed draws the same steps,
// notes and timings, and only the quits come by the clock.
import type { Executor } from '../harness/invoke-test'
import { invokeTest, sendTest } from '../harness/invoke-test'

/** How the soak reaches the app. */
export interface SoakDriver {
  executor(): Executor
  /** After the app quit: fails unless it exited, then starts it on the same profile and vault. */
  relaunch(): Promise<void>
  /**
   * After a call failed on the way to the app (the tunnel, the socket, the WebDriver session):
   * reconnects, and fails unless the app is still the same process. Without it such a failure
   * ends the soak.
   */
  recover?(): Promise<void>
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
  'rename',
  'move',
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
/** A round that takes longer is stuck: the app or the harness hangs. */
const ROUND_MS = 5 * 60_000
/** Random numbers each round draws, used or not, so a quit does not shift the rounds after it. */
const DRAWS = 12
const HISTORY = 12
/** Errors Windows gives a write while another process (Defender, the indexer) holds the file. */
const TRANSIENT = /os error (5|32|33)\b|being used by another process|access is denied/i

/** A call that never reached the app, or whose answer never came back. */
const TRANSPORT =
  /unreachable|fetch failed|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR|socket hang up|invalid session id|no such window|session .* not found/i
/** Reconnects in a row within one round before the soak gives up on the connection. */
const MAX_RECOVERIES = 5

const SOAK_FOLDER = 'soak'
/** Where `move` takes a note from the soak folder, and back. */
const MOVED_FOLDER = `${SOAK_FOLDER}/moved`

// Not `error`: WebDriver reads a script result with an `error` key as a failed command.
const COMMAND_SCRIPT = `
  const [name, args, done] = arguments;
  window.__TAURI__.core.invoke(name, args).then(
    (value) => done({ ok: true, value: value === undefined ? null : value }),
    (failure) => done({ ok: false, failure })
  );
`

/** Calls one of the app's own commands as the renderer does (`invokeTest` calls only `e2e_*`). */
export async function appCommand<T>(
  executor: Executor,
  name: string,
  args: Record<string, unknown> = {}
): Promise<T> {
  const outcome = (await executor.executeAsync(COMMAND_SCRIPT, name, args)) as {
    ok: boolean
    value?: unknown
    failure?: unknown
  }
  if (!outcome.ok) throw new Error(`${name} failed: ${JSON.stringify(outcome.failure)}`)
  return outcome.value as T
}

/** A failure of the soak's rules, already named with its seed, round and step. */
class SoakError extends Error {}

/** The round in progress: what a reconnect re-checks. */
interface Current {
  note: NoteFile
  before: Map<string, Seen>
  /** The note the step writes, or null when it writes none. */
  touched: string | null
  /** Every text the step has asked the app or a program to write so far. */
  candidates: string[]
  /** The touched note's path before a rename or move. */
  from?: string
  /** An app edit that may win over the outside save `kept`, which is then a version. */
  bodyWins?: { text: string; kept: string }
  /** Set once the app edit won and the outside save was read back as a version. */
  bodyWon?: boolean
}

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
  const history: Record<string, unknown>[] = []
  const show = (value: unknown): string => JSON.stringify(value)
  const named = (message: string): string =>
    `soak seed=${seed} round=${round} step=${step}: ${message} history=${show(history)}`
  const fail = (message: string): never => {
    throw new SoakError(named(message))
  }

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
  let current: Current | null = null
  const edit = (noteId: string, text: string): Promise<void> => {
    current?.candidates.push(text)
    return call('e2e_note_edit', { noteId, text })
  }
  async function save(path: string, text: string, replace: boolean): Promise<void> {
    current?.candidates.push(text.endsWith('\n') ? text.slice(0, -1) : text)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await call('e2e_vault_write_outside', { path, text, replace })
        return
      } catch (error) {
        if (attempt >= 3 || !TRANSIENT.test(String(error))) throw error
        log('retry', { round, path, attempt, error: String(error) })
        await sleep(250 * attempt)
      }
    }
  }

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
  const notes: NoteFile[] = []
  const expected = new Map<string, string>()
  const adopt = async (): Promise<void> => {
    await appCommand(driver.executor(), 'notes_create_folder', { path: MOVED_FOLDER })
    for (let i = 0; i < options.notes; i += 1) {
      const path = `${SOAK_FOLDER}/n${i}.md`
      await save(path, `n${i} start\n`, false)
      const note = await until(`${path} became a note`, async () =>
        (await rows()).find((row) => row.path === path && row.contentHash !== null)
      )
      if (!notes.some((known) => known.noteId === note.noteId)) notes.push(note)
      expected.set(note.noteId, `n${i} start`)
    }
    for (const note of notes) {
      const want = expected.get(note.noteId) as string
      await until(`${note.path} held ${show(want)}`, async () =>
        holds((await snapshot([note])).get(note.noteId), want) ? true : undefined
      )
    }
  }
  await guarded(adopt, adopt)

  /** Each note's path as its row says: a rename or move cut short may have moved it. */
  async function follow(): Promise<void> {
    const listed = new Map((await rows()).map((row) => [row.noteId, row.path]))
    for (const note of notes) note.path = listed.get(note.noteId) ?? note.path
  }

  /** Every note as `expected` says, in file and body, and no other note in the soak folder. */
  async function checkAll(): Promise<void> {
    await follow()
    const strays = (await rows()).filter(
      (row) =>
        row.path.startsWith(`${SOAK_FOLDER}/`) && !notes.some((note) => note.noteId === row.noteId)
    )
    if (strays.length > 0) fail(`files no note was made for: ${show(strays)}`)
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
  const steps = Object.fromEntries(STEPS.map((kind) => [kind, 0])) as Record<Step, number>
  const quits = Object.fromEntries(options.quits.map((kind) => [kind, 0])) as Record<Quit, number>
  let quitCount = 0
  let conclusive = 0
  let bodyWon = 0

  /** Whether one of the note's newest versions is the file `text` (a one-line body). */
  async function keptAsVersion(noteId: string, text: string): Promise<boolean> {
    const versions = await appCommand<{ id: string }[]>(driver.executor(), 'notes_get_versions', {
      noteId
    })
    for (const version of versions.slice(0, 5)) {
      const detail = await appCommand<{ fileContent: string } | null>(
        driver.executor(),
        'notes_get_version',
        { snapshotId: version.id }
      )
      if (detail?.fileContent === `${text}\n`) return true
    }
    return false
  }
  let recoveries = 0
  const others = STEPS.filter((kind) => kind !== 'quit')

  /** One round: the step, the wait for its outcome and the checks of every note. */
  async function runRound(): Promise<Record<string, unknown>> {
    const draws = Array.from({ length: DRAWS }, next)
    let used = 0
    const draw = (): number => draws[used++ % DRAWS]
    // The first rounds take every step once, so a short run covers them all; a quit that is due
    // takes the round's place without changing what it drew.
    const drawn =
      round <= others.length ? others[round - 1] : others[Math.floor(draw() * others.length)]
    const note = notes[Math.floor(draw() * notes.length)]
    step = Date.now() >= nextQuit ? 'quit' : drawn
    const tag = `r${round}`
    current = null
    const before = await snapshot(notes)
    const round_: Current = { note, before, touched: note.noteId, candidates: [] }
    current = round_
    let want = ''
    const extra: Record<string, unknown> = { note: note.path }

    switch (step) {
      case 'app-edit':
        want = `${tag} typed in the app`
        await edit(note.noteId, want)
        break
      case 'app-burst':
        for (let k = 0; k < 5; k += 1) {
          want = `${tag} typed ${k}`
          await edit(note.noteId, want)
          await sleep(Math.floor(draw() * 150))
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
        const typed = `${tag} typed in the app`
        await edit(note.noteId, typed)
        const delay = Math.max(0, Math.round(DEBOUNCE_MS + (draw() + draw() - 1) * 350))
        await sleep(delay)
        want = `${tag} saved by another program`
        await save(note.path, `${want}\n`, draw() < 0.5)
        round_.bodyWins = { text: typed, kept: want }
        extra.delayMs = delay
        break
      }
      case 'same-bytes-save': {
        // Saved again unchanged while the edit waits for its pass. A save that ends a debounce
        // or more after the edit began may have come after the pass, when the old bytes are a
        // real outside edit that wins; it proves nothing either way.
        const bytes = before.get(note.noteId)?.file?.text ?? fail(`${note.path} is missing`)
        want = `${tag} typed in the app`
        const began = Date.now()
        await edit(note.noteId, want)
        await save(note.path, bytes, draw() < 0.5)
        const took = Date.now() - began
        extra.editToSaveMs = took
        if (took >= DEBOUNCE_MS) {
          await sleep(PASS_DUE_MS)
          const old = bytes.endsWith('\n') ? bytes.slice(0, -1) : bytes
          want = await until(`${note.path} held the edit or the old text`, async () => {
            const seen = (await snapshot([note])).get(note.noteId)
            return holds(seen, want) ? want : holds(seen, old) ? old : undefined
          })
          extra.inconclusive = true
        } else {
          conclusive += 1
        }
        break
      }
      case 'schedule-unchanged': {
        round_.touched = null
        const chosen = notes.filter(() => draw() < 0.3).map((each) => each.noteId)
        await call('e2e_note_schedule', { noteIds: chosen.length > 0 ? chosen : [note.noteId] })
        await sleep(PASS_DUE_MS)
        break
      }
      case 'rename':
      case 'move': {
        // The new name while the text before it is still on its way: an app edit waiting for
        // its pass, or an outside save the feed has not taken yet.
        if (draw() < 0.5) {
          want = `${tag} typed before the ${step}`
          await edit(note.noteId, want)
        } else {
          want = `${tag} saved before the ${step}`
          await save(note.path, `${want}\n`, draw() < 0.5)
        }
        const delay = Math.floor(draw() * 2 * DEBOUNCE_MS)
        await sleep(delay)
        const from = note.path
        if (step === 'rename') {
          const title = `${tag} ${note.noteId.slice(0, 8)}`
          await appCommand(driver.executor(), 'notes_rename', { id: note.noteId, newTitle: title })
        } else {
          const to = from.startsWith(`${MOVED_FOLDER}/`) ? SOAK_FOLDER : MOVED_FOLDER
          await appCommand(driver.executor(), 'notes_move', { id: note.noteId, newFolder: to })
        }
        await follow()
        if (note.path === from) fail(`${from} kept its path after the ${step}`)
        round_.from = from
        Object.assign(extra, { delayMs: delay, from, to: note.path })
        break
      }
      case 'quit': {
        const quit = options.quits[quitCount % options.quits.length]
        want = `${tag} typed before the ${quit}`
        await edit(note.noteId, want)
        // The app may be gone before the reply.
        await (
          quit === 'request-quit'
            ? sendTest({ executor: driver.executor() }, 'e2e_request_quit')
            : call('e2e_send_session_end', { target: 'main', killWebview: true })
        ).catch(() => undefined)
        await driver.relaunch()
        // Counted once it happened: a round a reconnect cuts short is taken again.
        quitCount += 1
        quits[quit] += 1
        await reopened()
        nextQuit = Date.now() + options.quitEveryMs
        extra.quit = quit
        break
      }
    }

    await verify(round_, want)
    steps[step] += 1
    return { ...extra, want, ...(round_.bodyWon ? { bodyWon: true } : {}) }
  }

  /**
   * The checks that end a round. With `want` the touched note must settle on it; without (a
   * round a reconnect cut short) on its text before the round or any text the step wrote, the
   * same in file, body and row hash.
   */
  async function verify(c: Current, want: string | null): Promise<void> {
    await follow()
    if (c.from !== undefined && c.from !== c.note.path && (await read(c.from)) !== null) {
      fail(`${c.from} is still on disk after the note moved to ${c.note.path}`)
    }
    if (c.touched !== null) {
      const id = c.touched
      const allowed =
        want !== null ? [want] : [expected.get(id) as string, ...new Set(c.candidates)]
      if (want === null) await sleep(PASS_DUE_MS)
      if (c.bodyWins) allowed.push(c.bodyWins.text)
      const held = await until(`${c.note.path} held one of ${show(allowed)}`, async () => {
        const seen = (await snapshot([c.note])).get(id)
        return allowed.find((text) => holds(seen, text))
      })
      if (held === c.bodyWins?.text && want !== null) {
        const kept = c.bodyWins.kept
        await until(`${show(kept)}, written over, kept as a version`, async () =>
          (await keptAsVersion(id, kept)) ? true : undefined
        )
        bodyWon += 1
        c.bodyWon = true
      }
      expected.set(id, held)
    } else if (want === null) {
      await sleep(PASS_DUE_MS)
    }
    const after = await snapshot(notes)
    await sleep(STABLE_MS)
    const again = await snapshot(notes)
    for (const each of notes) {
      const id = each.noteId
      if (id === c.touched) {
        if (!same(after.get(id), again.get(id))) {
          fail(
            `${each.path} changed after it settled: ${show(after.get(id))} -> ${show(again.get(id))}`
          )
        }
      } else if (!same(c.before.get(id), again.get(id))) {
        fail(
          `${each.path}, not edited, changed: ${show(c.before.get(id))} -> ${show(again.get(id))}`
        )
      }
    }
  }

  /** The rest of a round a reconnect cut short: its checks, accepting any text it wrote. */
  async function resumeRound(): Promise<Record<string, unknown>> {
    const c = current
    // Cut short before it wrote anything: the next round checks every note again.
    if (c === null) return { interrupted: true, wrote: false }
    await verify(c, null)
    steps[step as Step] += 1
    return { note: c.note.path, interrupted: true, held: c.touched && expected.get(c.touched) }
  }

  /** Runs `work` as `step`, within the watchdog; any error comes out named. */
  async function guarded<T>(work: () => Promise<T>, resume?: () => Promise<T>): Promise<T> {
    let attempt = work
    for (let recovered = 0; ;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const watchdog = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new SoakError(named(`stuck for ${ROUND_MS / 60_000} min`))),
          ROUND_MS
        )
      })
      try {
        return await Promise.race([attempt(), watchdog])
      } catch (error) {
        if (error instanceof SoakError) throw error
        const message = error instanceof Error ? error.message : String(error)
        if (!driver.recover || !resume || !TRANSPORT.test(message) || recovered >= MAX_RECOVERIES) {
          throw new SoakError(named(message), { cause: error })
        }
        log('connection lost', { round, step, error: message })
        try {
          await driver.recover()
        } catch (gone) {
          throw new SoakError(named(gone instanceof Error ? gone.message : String(gone)), {
            cause: gone
          })
        }
        recovered += 1
        recoveries += 1
        log('reconnected', { round, step, recoveries })
        attempt = resume
      } finally {
        clearTimeout(timer)
      }
    }
  }

  while (Date.now() < end) {
    round += 1
    const began = Date.now()
    const outcome = await guarded(runRound, resumeRound)
    const entry = { round, step, ms: Date.now() - began, ...outcome }
    history.push(entry)
    if (history.length > HISTORY) history.shift()
    log('round', entry)

    if (Date.now() >= nextCheck) {
      nextCheck = Date.now() + options.checkEveryMs
      step = 'check'
      await guarded(checkAll, checkAll)
      log('check', {
        round,
        steps,
        quits,
        conclusive,
        bodyWon,
        recoveries,
        leftMin: Math.round((end - Date.now()) / 60_000)
      })
    }
  }
  step = 'check'
  await guarded(checkAll, checkAll)
  if (round === 0) fail('no round ran')
  const missing = [
    ...STEPS.filter((kind) => steps[kind] === 0),
    ...options.quits.filter((kind) => quits[kind] === 0)
  ]
  if (missing.length > 0) fail(`never took ${missing.join(', ')}`)
  if (conclusive === 0) fail('no same-bytes save was conclusive')
  log('soak passed', { rounds: round, steps, quits, conclusive, bodyWon, recoveries })
  return { rounds: round, steps }
}
