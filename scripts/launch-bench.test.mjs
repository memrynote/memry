import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'

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
  parseLaunchTimeline,
  parseLogTimestamp,
  parseRendererMarks,
  resolveExecutable,
  runsMissingNoteReadable,
  summarize
} from './launch-bench.mjs'

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

  it('keeps a chosen device and replaces an empty one', () => {
    assert.equal(benchEnv({ MEMRY_DEVICE: 'A' }, '/p').MEMRY_DEVICE, 'A')
    assert.equal(benchEnv({ MEMRY_DEVICE: '' }, '/p').MEMRY_DEVICE, 'launch-bench')
  })

  it('refuses the dev device, which shares the dev keychain accounts', () => {
    assert.throws(() => benchEnv({ MEMRY_DEVICE: 'dev' }, '/p'), /MEMRY_DEVICE/)
    assert.throws(() => benchEnv({ MEMRY_DEVICE: 'dev-0a1b2c3d' }, '/p'), /MEMRY_DEVICE/)
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

  it('accepts a bench profile', () => {
    assert.doesNotThrow(() =>
      checkProfile('/tmp/memry-launch-bench/profile', {}, 'darwin', '/Users/kaan')
    )
  })
})

describe('runsMissingNoteReadable', () => {
  function withMark(run, noteReadableMs) {
    return { ...makeRun(run, 'packaged', 0), renderer: { noteReadableMs } }
  }

  it('fails a run with no mark when another run had one, before or after it', () => {
    const runs = [
      withMark(1, null),
      withMark(2, 900),
      { ...makeRun(3, 'packaged', 0), renderer: null }
    ]
    assert.deepEqual(runsMissingNoteReadable(runs), [1, 3])
  })

  it('fails nothing when no run restored a note', () => {
    assert.deepEqual(runsMissingNoteReadable([withMark(1, null), withMark(2, null)]), [])
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
