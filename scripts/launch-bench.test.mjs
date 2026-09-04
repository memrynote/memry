import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  detectTier,
  findWindowShownAt,
  formatMedianTable,
  median,
  parseLaunchTimeline,
  parseLogTimestamp,
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

const SLICE = `${STARTING_LINE}\n${SHOWN_LINE}\n${TIMELINE_BLOCK}\n`

function makeRun(run, tier, offset) {
  return {
    run,
    tier,
    clickToShownMs: 1000 + offset,
    cdpAttachOffsetMs: 900 + offset,
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
    assert.equal(byKey.cdp_attach_offset_ms.median, 950)
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
        'cdp_attach_offset_ms',
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
