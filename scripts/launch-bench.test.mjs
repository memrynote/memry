import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startFakeWebDriver } from '../apps/desktop-tauri/scripts/lib/fake-webdriver.mjs'
import {
  benchEnv,
  checkProfile,
  classifyBuild,
  collectWarnings,
  defaultAppPath,
  detectTier,
  findWindowShownAt,
  formatMedianTable,
  logPath,
  median,
  noteReadableFailures,
  parseLaunchTimeline,
  parseLogTimestamp,
  parseRendererMarks,
  resolveExecutable,
  summarize
} from './launch-bench.mjs'
import {
  assertControlNamesProfile,
  controlFilePath,
  e2eControl,
  openOneNote,
  removeE2eControl,
  webdriverPort,
  writeE2eControl
} from './launch-bench-e2e.mjs'

const STARTING_LINE =
  '2026-09-04 14:13:53.280 [info]  [ (Main)                         ] MemryNote 2026.903.2 starting (packaged)'
const SHOWN_LINE =
  '2026-09-04 14:13:53.758 [info]  [ (Main)                         ] main window shown (ready-to-show)'
const TIMELINE_BLOCK = `2026-09-04 14:13:53.759 [info]  [ (Startup)                      ] launch timeline {
  reason: 'ready-to-show',
  appReadyMs: 703,
  windowCreatedMs: 797,
  vaultOpenStartMs: 801,
  vaultOpenReadyMs: 875,
  readyToShowMs: 1063,
  shownMs: 1076,
  fallback: false,
  vaultOpenPending: false
}`

// The line `launch_report_renderer_marks` logs (`src-tauri/src/commands/launch.rs`).
const RENDERER_LINE =
  '2026-09-04 14:13:54.900 [info] [Startup] renderer launch marks {"firstPaintMs":null,"fcpMs":512.5,"domInteractiveMs":301,"domContentLoadedMs":340.25,"noteReadableMs":1210}'

const SLICE = `${STARTING_LINE}\n${SHOWN_LINE}\n${TIMELINE_BLOCK}\n`

function makeRun(run, tier, offset) {
  return {
    run,
    tier,
    clickToShownMs: 1000 + offset,
    timeline: { appReadyMs: 700 + offset, shownMs: 1076 + offset },
    renderer: { fcpMs: 756.5 + offset }
  }
}

describe('parseLogTimestamp', () => {
  it('reads a real log line as local time', () => {
    assert.equal(parseLogTimestamp(SHOWN_LINE), new Date(2026, 8, 4, 14, 13, 53, 758).getTime())
  })

  it('returns null for a stack-trace continuation line', () => {
    assert.equal(
      parseLogTimestamp('    at Object.<anonymous> (/Users/h4yfans/worktrees/a/src/main/index.ts)'),
      null
    )
  })
})

describe('parseLaunchTimeline', () => {
  it('reads the multi-line block', () => {
    assert.deepEqual(parseLaunchTimeline(SLICE), {
      reason: 'ready-to-show',
      appReadyMs: 703,
      windowCreatedMs: 797,
      vaultOpenStartMs: 801,
      vaultOpenReadyMs: 875,
      readyToShowMs: 1063,
      shownMs: 1076,
      fallback: false,
      vaultOpenPending: false
    })
  })

  it('returns null when the block is absent', () => {
    assert.equal(parseLaunchTimeline(`${STARTING_LINE}\n${SHOWN_LINE}\n`), null)
  })

  it('returns null while the block is still unclosed', () => {
    const truncated = SLICE.split('\n').slice(0, -2).join('\n')
    assert.equal(parseLaunchTimeline(truncated), null)
  })
})

describe('parseRendererMarks', () => {
  it('reads the renderer line, an absent mark as null', () => {
    assert.deepEqual(parseRendererMarks(`${SLICE}${RENDERER_LINE}\n`), {
      firstPaintMs: null,
      fcpMs: 512.5,
      domInteractiveMs: 301,
      domContentLoadedMs: 340.25,
      noteReadableMs: 1210
    })
  })

  it('returns null without the line, and for a line cut mid-write', () => {
    assert.equal(parseRendererMarks(SLICE), null)
    assert.equal(parseRendererMarks(RENDERER_LINE.slice(0, -10)), null)
  })

  it('feeds the renderer metrics, a null mark as absent', () => {
    const run = { ...makeRun(1, 'packaged', 0), renderer: parseRendererMarks(RENDERER_LINE) }
    const byKey = Object.fromEntries(summarize([run]).map((row) => [row.key, row.median]))
    assert.equal(byKey.renderer_note_readable_ms, 1210)
    assert.equal(byKey.renderer_fcp_ms, 512.5)
    assert.equal(byKey.renderer_first_paint_ms, null)
  })
})

describe('logPath', () => {
  it('follows the Tauri log dir of each OS', () => {
    assert.equal(
      logPath({}, 'darwin', '/Users/kaan'),
      '/Users/kaan/Library/Logs/com.memrynote.memry/main.log'
    )
    assert.equal(
      logPath({ LOCALAPPDATA: 'C:\\Users\\kaan\\AppData\\Local' }, 'win32', 'C:\\Users\\kaan'),
      'C:\\Users\\kaan\\AppData\\Local\\com.memrynote.memry\\logs\\main.log'
    )
    assert.equal(
      logPath({}, 'linux', '/home/kaan'),
      '/home/kaan/.local/share/com.memrynote.memry/logs/main.log'
    )
    assert.equal(
      logPath({ XDG_DATA_HOME: '/data' }, 'linux', '/home/kaan'),
      '/data/com.memrynote.memry/logs/main.log'
    )
  })

  it('follows MEMRY_DEVICE and MEMRY_TEST_LOG_DIR as the app does', () => {
    assert.equal(
      logPath({ MEMRY_DEVICE: 'A' }, 'darwin', '/Users/kaan'),
      '/Users/kaan/Library/Logs/com.memrynote.memry.A/main.log'
    )
    assert.equal(
      logPath({ MEMRY_TEST_LOG_DIR: '/tmp/logs', MEMRY_DEVICE: 'A' }, 'linux', '/home/kaan'),
      '/tmp/logs/main.log'
    )
  })
})

describe('defaultAppPath', () => {
  it('names the install of each OS, none on Linux', () => {
    assert.equal(defaultAppPath({}, 'darwin', '/Users/kaan'), '/Applications/MemryNote.app')
    assert.equal(
      defaultAppPath({ LOCALAPPDATA: 'C:\\L' }, 'win32', 'C:\\Users\\kaan'),
      'C:\\L\\MemryNote\\current\\Memrynote.exe'
    )
    assert.equal(defaultAppPath({}, 'linux', '/home/kaan'), null)
  })
})

describe('findWindowShownAt', () => {
  it('picks the last match, not the first', () => {
    const later =
      '2026-09-04 14:20:01.500 [info]  [ (Main)                         ] main window shown (fallback-timeout)'
    assert.equal(
      findWindowShownAt(`${SLICE}${later}\n`),
      new Date(2026, 8, 4, 14, 20, 1, 500).getTime()
    )
  })

  it('returns null when no window was shown', () => {
    assert.equal(findWindowShownAt(STARTING_LINE), null)
  })
})

describe('detectTier', () => {
  it('reads packaged, dev, and unknown', () => {
    assert.equal(detectTier(SLICE), 'packaged')
    assert.equal(detectTier(STARTING_LINE.replace('(packaged)', '(dev)')), 'dev')
    assert.equal(detectTier(SHOWN_LINE), 'unknown')
  })
})

describe('median', () => {
  it('takes the middle value of an odd count', () => {
    assert.equal(median([3, 1, 2]), 2)
  })

  it('averages the two middle values of an even count', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5)
  })

  it('returns null for an empty list', () => {
    assert.equal(median([]), null)
  })
})

describe('summarize', () => {
  it('refuses click_to_shown_ms when any run is not packaged, and still reports the rest', () => {
    const summary = summarize([makeRun(1, 'packaged', 0), makeRun(2, 'dev', 100)])
    const byKey = Object.fromEntries(summary.map((row) => [row.key, row]))

    assert.equal(byKey.click_to_shown_ms.median, null)
    assert.equal(byKey.click_to_shown_ms.note, 'refused: not tier 3 (packaged)')
    assert.equal(byKey.app_ready_ms.median, 750)
    assert.equal(byKey.app_ready_ms.note, null)
    assert.equal(byKey.renderer_fcp_ms.median, 806.5)
    assert.equal(byKey.renderer_loaded_ms.median, null)
  })

  it('reports click_to_shown_ms when every run is packaged', () => {
    const summary = summarize([makeRun(1, 'packaged', 0), makeRun(2, 'packaged', 100)])
    const clickToShown = summary.find((row) => row.key === 'click_to_shown_ms')

    assert.equal(clickToShown.median, 1050)
    assert.equal(clickToShown.note, null)
  })

  it('keeps the metric order stable', () => {
    assert.deepEqual(
      summarize([]).map((row) => row.key),
      [
        'click_to_shown_ms',
        'app_ready_ms',
        'window_created_ms',
        'vault_open_start_ms',
        'vault_open_ready_ms',
        'renderer_loaded_ms',
        'ready_to_show_ms',
        'shown_ms',
        'renderer_first_paint_ms',
        'renderer_fcp_ms',
        'renderer_dom_interactive_ms',
        'renderer_dom_content_loaded_ms',
        'renderer_note_readable_ms'
      ]
    )
  })

  it('reports renderer_note_readable_ms absent, not zero, when no note was restored', () => {
    const summary = summarize([makeRun(1, 'packaged', 0), makeRun(2, 'packaged', 100)])
    const noteReadable = summary.find((row) => row.key === 'renderer_note_readable_ms')

    assert.equal(noteReadable.median, null)
  })

  it('reports renderer_note_readable_ms when the mark landed', () => {
    const runs = [makeRun(1, 'packaged', 0), makeRun(2, 'packaged', 100)]
    runs[0].renderer.noteReadableMs = 900
    runs[1].renderer.noteReadableMs = 1000
    const summary = summarize(runs)
    const noteReadable = summary.find((row) => row.key === 'renderer_note_readable_ms')

    assert.equal(noteReadable.median, 950)
  })
})

describe('formatMedianTable', () => {
  it('prints no measurement on the refused row', () => {
    const runs = [makeRun(1, 'packaged', 0), makeRun(2, 'dev', 100)]
    const table = formatMedianTable(summarize(runs), runs)
    const refusedRow = table.split('\n').find((line) => line.startsWith('click_to_shown_ms'))

    assert.match(refusedRow, /refused \(not tier 3\)/)
    assert.equal(/\d/.test(refusedRow.replace('tier 3', 'tier')), false)
  })

  it('renders an absent metric as a dash and names the per-run tiers', () => {
    const runs = [makeRun(1, 'packaged', 0)]
    const table = formatMedianTable(summarize(runs), runs)

    assert.match(table, /^runs: 1 \(#1 packaged\)$/m)
    assert.match(table, /^renderer_loaded_ms\s+-$/m)
    assert.match(table, /^click_to_shown_ms\s+1000 ms$/m)
  })
})

describe('benchEnv', () => {
  it('runs the app as its own device on the bench profile', () => {
    const env = benchEnv({ HOME: '/Users/kaan' }, '/tmp/bench/profile')

    assert.equal(env.MEMRY_DEVICE, 'launch-bench')
    assert.equal(env.MEMRY_APP_DATA_DIR, '/tmp/bench/profile')
    assert.equal(env.HOME, '/Users/kaan')
    assert.equal(
      logPath(env, 'darwin', '/Users/kaan'),
      '/Users/kaan/Library/Logs/com.memrynote.memry.launch-bench/main.log'
    )
  })

  it('keeps a launch-bench device, trimmed, and replaces an empty one', () => {
    assert.equal(
      benchEnv({ MEMRY_DEVICE: 'launch-bench-b2' }, '/p').MEMRY_DEVICE,
      'launch-bench-b2'
    )
    assert.equal(benchEnv({ MEMRY_DEVICE: ' launch-bench ' }, '/p').MEMRY_DEVICE, 'launch-bench')
    assert.equal(benchEnv({ MEMRY_DEVICE: '' }, '/p').MEMRY_DEVICE, 'launch-bench')
  })

  it('refuses every other device, which may hold a signed-in account', () => {
    for (const device of ['dev', 'dev-0a1b2c3d', 'A', 'B', 'Launch-Bench', 'launch-bench-', ' ']) {
      assert.throws(() => benchEnv({ MEMRY_DEVICE: device }, '/p'), /MEMRY_DEVICE/, device)
    }
  })
})

describe('classifyBuild', () => {
  it('keeps the starting line tier for an installed build', () => {
    assert.equal(
      classifyBuild(SLICE, '/Applications/MemryNote.app/Contents/MacOS/MemryNote', {}),
      'packaged'
    )
    assert.equal(TIER_OF(classifyBuild(SLICE, '/opt/MemryNote', {})), true)
  })

  it('marks a debug bundle or an e2e build as debug, with no valid wall clock', () => {
    const debugBundle =
      '/repo/crates/target/debug/bundle/macos/MemryNote.app/Contents/MacOS/MemryNote'
    assert.equal(classifyBuild(SLICE, debugBundle, {}), 'debug')
    assert.equal(
      classifyBuild(
        SLICE,
        'C:\\repo\\crates\\target\\x86_64-pc-windows-msvc\\debug\\memry.exe',
        {}
      ),
      'debug'
    )
    assert.equal(classifyBuild(SLICE, '/opt/MemryNote', { MEMRY_E2E: '1' }), 'debug')
    assert.equal(TIER_OF('debug'), false)
  })
})

function TIER_OF(tier) {
  const runs = [{ ...makeRun(1, tier, 0) }]
  return summarize(runs).find((row) => row.key === 'click_to_shown_ms').note === null
}

describe('resolveExecutable', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'launch-bench-test-'))
  after(() => rmSync(root, { recursive: true, force: true }))

  function makeApp(name, executable) {
    const app = path.join(root, name)
    mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true })
    writeFileSync(
      path.join(app, 'Contents/Info.plist'),
      `<plist><dict><key>CFBundleExecutable</key>\n  <string>${executable}</string></dict></plist>`
    )
    return app
  }

  it('reads the executable of a Tauri bundle from Info.plist', () => {
    const app = makeApp('Renamed.app', 'MemryNote')
    assert.equal(resolveExecutable(app), path.join(app, 'Contents/MacOS/MemryNote'))
  })

  it('refuses an Electron bundle', () => {
    const app = makeApp('Electron.app', 'Memry')
    mkdirSync(path.join(app, 'Contents/Frameworks/Electron Framework.framework'), {
      recursive: true
    })
    assert.throws(() => resolveExecutable(app), /Electron build/)
  })

  it('refuses an Electron executable next to resources/app.asar', () => {
    const dir = path.join(root, 'win-unpacked')
    mkdirSync(path.join(dir, 'resources'), { recursive: true })
    writeFileSync(path.join(dir, 'resources', 'app.asar'), '')
    assert.throws(() => resolveExecutable(path.join(dir, 'Memry.exe')), /Electron build/)
  })

  it('refuses an AppImage unless it is declared a Tauri build', () => {
    const appImage = path.join(root, 'MemryNote.AppImage')
    writeFileSync(appImage, '')
    assert.throws(() => resolveExecutable(appImage), /--tauri-appimage/)
    assert.equal(resolveExecutable(appImage, { tauriAppImage: true }), appImage)
  })

  it('passes a plain Tauri executable through', () => {
    assert.equal(resolveExecutable('/opt/memry/memrynote'), '/opt/memry/memrynote')
  })
})

describe('checkProfile', () => {
  it('refuses the default Tauri data dir of each OS', () => {
    assert.throws(
      () =>
        checkProfile(
          '/Users/kaan/Library/Application Support/com.memrynote.memry/',
          {},
          'darwin',
          '/Users/kaan'
        ),
      /real profile/
    )
    assert.throws(
      () =>
        checkProfile(
          'C:\\Users\\kaan\\AppData\\Roaming\\com.memrynote.memry',
          { APPDATA: 'C:\\Users\\kaan\\AppData\\Roaming' },
          'win32',
          'C:\\Users\\kaan'
        ),
      /real profile/
    )
    assert.throws(
      () => checkProfile('/home/kaan/.local/share/com.memrynote.memry', {}, 'linux', '/home/kaan'),
      /real profile/
    )
  })

  it('ignores case on macOS and Windows', () => {
    assert.throws(
      () =>
        checkProfile(
          '/USERS/KAAN/Library/Application Support/COM.MEMRYNOTE.MEMRY',
          {},
          'darwin',
          '/Users/kaan'
        ),
      /real profile/
    )
    assert.throws(
      () =>
        checkProfile(
          'c:\\users\\KAAN\\appdata\\roaming\\Com.MemryNote.Memry',
          { APPDATA: 'C:\\Users\\kaan\\AppData\\Roaming' },
          'win32',
          'C:\\Users\\kaan'
        ),
      /real profile/
    )
  })

  describe('on disk', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'launch-bench-home-'))
    after(() => rmSync(home, { recursive: true, force: true }))
    // `env` is empty, so the default data dir derives from `home` on every OS.
    const realProfile =
      {
        darwin: path.join(home, 'Library/Application Support/com.memrynote.memry'),
        win32: path.join(home, 'AppData/Roaming/com.memrynote.memry')
      }[process.platform] ?? path.join(home, '.local/share/com.memrynote.memry')

    it('creates and accepts a bench profile', () => {
      const profile = path.join(home, 'bench', 'profile')
      checkProfile(profile, {}, process.platform, home)
      assert.ok(existsSync(profile))
    })

    it('refuses a link to the real profile', () => {
      mkdirSync(realProfile, { recursive: true })
      const link = path.join(home, 'linked-profile')
      symlinkSync(realProfile, link, process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => checkProfile(link, {}, process.platform, home), /real profile/)
    })
  })
})

describe('noteReadableFailures', () => {
  function withMark(run, noteReadableMs) {
    return { ...makeRun(run, 'packaged', 0), renderer: { noteReadableMs } }
  }

  it('fails a run with no mark when another run had one, before or after it', () => {
    const runs = [
      withMark(1, null),
      withMark(2, 900),
      { ...makeRun(3, 'packaged', 0), renderer: null }
    ]
    assert.deepEqual(noteReadableFailures(runs), [
      { run: 1, message: 'no note-readable mark, while another run had one' },
      {
        run: 3,
        message: 'no "renderer launch marks" line, while another run had a note-readable mark'
      }
    ])
  })

  it('fails nothing when no run restored a note', () => {
    assert.deepEqual(noteReadableFailures([withMark(1, null), withMark(2, null)]), [])
  })
})

describe('collectWarnings', () => {
  it('names the 8 s wait, not a missing restore', () => {
    const record = {
      tier: 'packaged',
      timeline: { rendererLoadedMs: 1 },
      renderer: { fcpMs: 1, noteReadableMs: null }
    }
    assert.ok(
      collectWarnings(record).some((warning) =>
        warning.startsWith('no note-readable mark within 8 s of load')
      )
    )
  })
})

// `script` tells the three page calls apart; the fake answers each as the page would. `notes`
// is what `notes_list` answers on each call, the last answer repeating.
async function startDriver(notes, tabStateStoredAtOpen, ready = () => true) {
  const state = { opens: [], listCalls: 0 }
  const driver = await startFakeWebDriver((method, url, body) => {
    if (url === '/status') return { ready: ready() }
    if (url === '/session') return { sessionId: 's1' }
    if (body.script.includes('vault_get_status')) return { ok: true, value: true }
    if (body.script.includes('notes_list')) {
      state.listCalls += 1
      return { ok: true, value: notes[Math.min(state.listCalls, notes.length) - 1] }
    }
    state.opens.push(body.args[0])
    return { ok: true, value: state.opens.length >= tabStateStoredAtOpen }
  })
  return { driver, state }
}

describe('the e2e control file', () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'launch-bench-e2e-test-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))

  it('points the app at --profile, with the bench device and its own log dir', () => {
    const env = benchEnv({ TAURI_WEBDRIVER_PORT: '4555' }, '/tmp/bench/profile')
    const { file, control } = writeE2eControl(env, '/tmp/bench/profile', tmp)

    assert.equal(file, path.join(tmp, 'memry-e2e', 'control-4555.json'))
    // The keys of `memry_desktop::e2e::control::ControlFile`, which denies unknown fields.
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      appDataDir: '/tmp/bench/profile',
      logDir: path.join('/tmp/bench/profile', 'logs'),
      device: 'launch-bench',
      testVaultPath: null,
      syncServerUrl: null,
      extraEnv: {}
    })
    assert.deepEqual(control, e2eControl(env, '/tmp/bench/profile'))
  })

  it('takes the port the app takes: TAURI_WEBDRIVER_PORT, else the plugin default', () => {
    assert.equal(webdriverPort({ TAURI_WEBDRIVER_PORT: '9222' }), 9222)
    for (const raw of [undefined, '', 'abc', '70000', '-1', '12 ']) {
      assert.equal(webdriverPort({ TAURI_WEBDRIVER_PORT: raw }), 4445, String(raw))
    }
    assert.equal(controlFilePath('/t', 4445), path.join('/t', 'memry-e2e', 'control-4445.json'))
  })

  it('refuses a launch when the control file is missing or names another profile', () => {
    const env = benchEnv({ TAURI_WEBDRIVER_PORT: '4556' }, '/tmp/bench/profile')
    const file = controlFilePath(tmp, 4556)

    assert.throws(
      () => assertControlNamesProfile(file, '/tmp/bench/profile'),
      (error) =>
        error.message.includes('MEMRY_E2E=1') &&
        error.message.includes(file) &&
        error.message.includes('is missing or unreadable') &&
        error.message.includes('unset MEMRY_E2E')
    )

    writeE2eControl(env, '/tmp/other/profile', tmp)
    assert.throws(
      () => assertControlNamesProfile(file, '/tmp/bench/profile'),
      /names \/tmp\/other\/profile, not \/tmp\/bench\/profile/
    )

    rmSync(file)
    writeE2eControl(env, '/tmp/bench/profile', tmp)
    assert.doesNotThrow(() => assertControlNamesProfile(file, '/tmp/bench/profile'))
  })

  it("rewrites the bench's own leftover file and refuses any other file on the port", () => {
    const env = benchEnv({ TAURI_WEBDRIVER_PORT: '4558' }, '/tmp/bench/profile')
    const file = controlFilePath(tmp, 4558)
    writeE2eControl(env, '/tmp/bench/profile', tmp)
    assert.doesNotThrow(() => writeE2eControl(env, '/tmp/bench/profile', tmp))

    writeFileSync(file, JSON.stringify({ appDataDir: '/live/session' }))
    assert.throws(
      () => writeE2eControl(env, '/tmp/bench/profile', tmp),
      (error) =>
        error.message.includes('port 4558') &&
        error.message.includes(file) &&
        error.message.includes('names /live/session, not the bench profile /tmp/bench/profile')
    )
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).appDataDir, '/live/session', 'left alone')

    writeFileSync(file, '{')
    assert.throws(() => writeE2eControl(env, '/tmp/bench/profile', tmp), /port 4558.*unreadable/)
  })

  it("removes only a control file that is still the bench's", () => {
    const env = benchEnv({ TAURI_WEBDRIVER_PORT: '4557' }, '/tmp/bench/profile')
    const { file } = writeE2eControl(env, '/tmp/other/profile', tmp)

    removeE2eControl(file, '/tmp/bench/profile')
    assert.ok(existsSync(file), "another session's file stays")

    rmSync(file)
    writeE2eControl(env, '/tmp/bench/profile', tmp)
    removeE2eControl(file, '/tmp/bench/profile')
    assert.ok(!existsSync(file))
  })
})

describe('openOneNote', () => {
  it('opens the first note of the vault until its tab state is stored', async () => {
    const note = { id: 'n1', title: 'First note' }
    const { driver, state } = await startDriver([note], 2)
    try {
      assert.equal(await openOneNote(driver.port, () => true), 'n1')
      assert.deepEqual(state.opens, [note, note])
    } finally {
      await driver.close()
    }
  })

  it('waits for the index to list a note after the vault opens', async () => {
    const note = { id: 'n2', title: 'Indexed later' }
    const { driver, state } = await startDriver([null, null, note], 1)
    try {
      assert.equal(await openOneNote(driver.port, () => true), 'n2')
      assert.equal(state.listCalls, 3)
    } finally {
      await driver.close()
    }
  })

  it('stops when the app exits while the vault lists no note', async () => {
    const { driver } = await startDriver([null], 1)
    let polls = 0
    try {
      await assert.rejects(
        () => openOneNote(driver.port, () => (polls += 1) <= 6),
        /the app exited before the vault listed a note/
      )
    } finally {
      await driver.close()
    }
  })

  it('stops when the app has exited', async () => {
    await assert.rejects(() => openOneNote(1, () => false), /the app exited before/)
  })
})

// The bench as `pnpm bench:launch` runs it, on a fake e2e app. It counts its launches in
// FAKE_LAUNCHES (the first is the priming) and creates that file once it handles SIGTERM, which
// is when the fake WebDriver reports ready. It logs a finished launch like the real one, and acts
// on the bench's first SIGTERM as FAKE_FIRST_TERM says: `remove-control` (an e2e run on the same
// port took the control file) or `ignore` (the bench has to kill it).
const FAKE_APP = `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const env = process.env
const first = !fs.existsSync(env.FAKE_LAUNCHES)
process.on('SIGTERM', () => {
  if (first && env.FAKE_FIRST_TERM === 'ignore') return
  if (first && env.FAKE_FIRST_TERM === 'remove-control') fs.rmSync(env.FAKE_CONTROL, { force: true })
  process.exit(0)
})
fs.mkdirSync(env.MEMRY_TEST_LOG_DIR, { recursive: true })
fs.appendFileSync(path.join(env.MEMRY_TEST_LOG_DIR, 'main.log'), env.FAKE_LOG)
fs.appendFileSync(env.FAKE_LAUNCHES, 'launch\\n')
setInterval(() => {}, 1000)
`

describe(
  'the bench CLI on an e2e build',
  { concurrency: true, skip: process.platform === 'win32' && 'the fake app is a shebang script' },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), 'launch-bench-cli-test-'))
    after(() => rmSync(root, { recursive: true, force: true }))

    // `TMPDIR` gives each run its own control file directory and bench lock.
    async function runBench(name, { firstTerm = '', beforeRun } = {}) {
      const dir = path.join(root, name)
      const vault = path.join(dir, 'vault')
      mkdirSync(path.join(vault, '.memry'), { recursive: true })
      const launches = path.join(dir, 'launches')
      const note = { id: 'n1', title: 'First note' }
      const { driver } = await startDriver([note], 1, () => existsSync(launches))
      const control = controlFilePath(dir, driver.port)
      const app = path.join(dir, 'fake-app.cjs')
      writeFileSync(app, FAKE_APP, { mode: 0o755 })
      beforeRun?.(control)
      const args = ['--app', app, '--vault', vault, '--profile', path.join(dir, 'profile')]
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./launch-bench.mjs', import.meta.url)), ...args, '--runs', '1'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          env: {
            ...process.env,
            TMPDIR: dir,
            MEMRY_DEVICE: '',
            MEMRY_E2E: '1',
            TAURI_WEBDRIVER_PORT: String(driver.port),
            FAKE_LAUNCHES: launches,
            FAKE_CONTROL: control,
            FAKE_FIRST_TERM: firstTerm,
            FAKE_LOG: `${SLICE}${RENDERER_LINE}\n`
          }
        }
      )
      let stderr = ''
      child.stderr.on('data', (chunk) => (stderr += chunk))
      const code = await new Promise((resolve) => child.once('close', resolve))
      await driver.close()
      const launched = existsSync(launches)
        ? readFileSync(launches, 'utf8').trim().split('\n').length
        : 0
      return { code, stderr, control, port: driver.port, launched }
    }

    it('stops with exit 2 and measures nothing when the app removes the control file', async () => {
      const result = await runBench('removed', { firstTerm: 'remove-control' })

      assert.equal(result.code, 2, result.stderr)
      assert.ok(result.stderr.includes(result.control), result.stderr)
      assert.ok(result.stderr.includes('is missing or unreadable'), result.stderr)
      assert.equal(result.launched, 1, 'the priming launch only: no run launched afterwards')
    })

    it("launches nothing on another session's control file", async () => {
      const result = await runBench('foreign', {
        beforeRun: (control) => {
          mkdirSync(path.dirname(control), { recursive: true })
          writeFileSync(control, JSON.stringify({ appDataDir: '/live/session' }))
        }
      })

      assert.equal(result.code, 2, result.stderr)
      assert.ok(result.stderr.includes(`port ${result.port}`), result.stderr)
      assert.ok(result.stderr.includes(result.control), result.stderr)
      assert.ok(result.stderr.includes('/live/session'), result.stderr)
      assert.equal(result.launched, 0)
      assert.equal(JSON.parse(readFileSync(result.control, 'utf8')).appDataDir, '/live/session')
    })

    it('fails the bench when priming had to kill the app, instead of measuring', async () => {
      const result = await runBench('killed', { firstTerm: 'ignore' })

      assert.equal(result.code, 2, result.stderr)
      assert.match(result.stderr, /priming: the app did not quit within \d+ ms and was killed/)
      assert.equal(result.launched, 1, 'the priming launch only: no run launched afterwards')
    })
  }
)
