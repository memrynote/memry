/**
 * Class: settings merge (`settings-merge.json`).
 *
 * Chapter 06 §6.9.0: a settings path is arbitrated by §6.3's field rule, over
 * the union of both payloads' `fieldClocks` keys (#2383). The generator
 * enumerates payload pairs and records the real output of
 * `mergeSettingsPayloads`, the function desktop's `mergeRemote` runs.
 *
 * A case carrying `rustPending` is one the Rust core
 * (`crates/memry-core/src/sync/settings_merge.rs`) still resolves differently;
 * its harness asserts that it does, so a fix there forces the flag's removal.
 *
 * Determinism: D1. Every function here is pure.
 */
import type { SettingsSyncPayload } from '../../src/settings-sync'
import { mergeSettingsPayloads } from '../../../sync-client/src/settings-merge.ts'
import { meta } from './shared'

const A = 'device-a'
const B = 'device-b'
const C = 'device-c'
const OFF = '_offline'
const PATH = 'general.accentColor'

const ABSENT_WINNER_KEEPS_LOCAL =
  'the Rust core removes the path when the winner has no value; §6.9.0 defers removal until desktop keeps unmodelled keys (#2183)'

interface SettingsMergeSpec {
  name: string
  pins: string
  local: SettingsSyncPayload
  remote: SettingsSyncPayload
  rustPending?: string
}

type Clock = Record<string, number>

/** One path, one value per side; `undefined` means the side holds no value there. */
const onePath = (
  name: string,
  localValue: string | undefined,
  remoteValue: string | undefined,
  localClock: Clock,
  remoteClock: Clock,
  pins: string,
  rustPending?: string
): SettingsMergeSpec => ({
  name,
  pins,
  local: {
    settings: { general: localValue === undefined ? {} : { accentColor: localValue } },
    fieldClocks: { [PATH]: localClock }
  },
  remote: {
    settings: { general: remoteValue === undefined ? {} : { accentColor: remoteValue } },
    fieldClocks: { [PATH]: remoteClock }
  },
  ...(rustPending ? { rustPending } : {})
})

const SPECS: SettingsMergeSpec[] = [
  onePath('row-1-remote-total-greater', 'x', 'y', { [A]: 2, [B]: 1 }, { [C]: 5 }, '§6.3.2 row 1'),
  onePath(
    'row-2-plain-tie-remote-wins',
    'x',
    'y',
    { [A]: 1 },
    { [B]: 1 },
    '§6.3.2 row 2: REMOTE wins a tie; tick-max kept local here'
  ),
  onePath('row-3-equal-clocks', 'x', 'y', { [A]: 3, [B]: 1 }, { [A]: 3, [B]: 1 }, '§6.3.2 row 3'),
  onePath(
    'row-4-local-offline-wins-tie',
    'x',
    'y',
    { [A]: 1, [OFF]: 1 },
    { [B]: 2 },
    '§6.3.2 row 4: the side carrying _offline wins a tie'
  ),
  onePath(
    'row-5-both-offline-remote-wins',
    'x',
    'y',
    { [A]: 1, [OFF]: 1 },
    { [B]: 1, [OFF]: 1 },
    '§6.3.2 row 5'
  ),
  onePath('row-6-offline-needs-differ', 'x', 'x', { [A]: 1, [OFF]: 1 }, { [B]: 2 }, '§6.3.2 row 6'),
  onePath('row-7-empty-clocks', 'x', 'y', {}, {}, '§6.3.2 row 7'),
  onePath(
    'row-8-sum-beats-causality',
    'x',
    'y',
    { [A]: 4 },
    { [A]: 1, [B]: 1, [C]: 1 },
    '§6.3.2 row 8: the sum, not compare, picks the winner'
  ),
  onePath('row-9-local-dominates', 'x', 'y', { [A]: 2 }, { [A]: 1 }, '§6.3.2 row 9'),
  onePath(
    'row-10-absent-winner-keeps-local',
    'x',
    undefined,
    { [A]: 1 },
    { [A]: 2 },
    '§6.3.2 row 10 on a settings path: the remote wins with no value, the local value stays',
    ABSENT_WINNER_KEEPS_LOCAL
  ),
  onePath(
    'stripped-value-echo-keeps-local',
    'x',
    undefined,
    { [A]: 1 },
    { [A]: 1 },
    'an older build stripped the value its schema does not model and echoed the clock (#16): a tie the remote wins with no value',
    ABSENT_WINNER_KEEPS_LOCAL
  ),
  onePath(
    'legacy-local-key',
    'x',
    'y',
    { local: 3 },
    { local: 3, [A]: 1 },
    '#2287: a stored `local` component is an ordinary key'
  ),
  {
    name: 'two-days-two-clocks',
    pins: '§6.9: a clock per weekday keeps both concurrent edits',
    local: {
      settings: { journal: { weekdayTemplates: { '3': 'wed-local' } } },
      fieldClocks: { 'journal.weekdayTemplates.3': { [A]: 1 } }
    },
    remote: {
      settings: { journal: { weekdayTemplates: { '4': 'thu-remote' } } },
      fieldClocks: { 'journal.weekdayTemplates.4': { [B]: 1 } }
    }
  },
  {
    name: 'single-clocked-list',
    pins: '§6.9: sidebar.sectionOrder moves as one value under one clock',
    local: {
      settings: { sidebar: { sectionOrder: ['notes', 'tasks', 'calendar'] } },
      fieldClocks: { 'sidebar.sectionOrder': { [A]: 1 } }
    },
    remote: {
      settings: { sidebar: { sectionOrder: ['calendar', 'notes', 'tasks'] } },
      fieldClocks: { 'sidebar.sectionOrder': { [B]: 2 } }
    }
  },
  {
    name: 'explicit-null-is-a-value',
    pins: '§13.4: null is a clear that wins like any value',
    local: {
      settings: { journal: { weekdayTemplates: { '1': 'morning-pages' } } },
      fieldClocks: { 'journal.weekdayTemplates.1': { [A]: 1 } }
    },
    remote: {
      settings: { journal: { weekdayTemplates: { '1': null } } },
      fieldClocks: { 'journal.weekdayTemplates.1': { [A]: 1, [B]: 1 } }
    }
  },
  {
    name: 'unaddressable-key-rides-along',
    pins: '§6.9.0: a clock key that is not a path keeps its union clock and arbitrates nothing',
    local: { settings: { general: { accentColor: 'x' } }, fieldClocks: { [PATH]: { [A]: 1 } } },
    remote: {
      settings: { general: { accentColor: 'x' } },
      fieldClocks: { [PATH]: { [A]: 1 }, 'general.': { [B]: 1 } }
    }
  },
  {
    name: 'unclocked-keys-local-kept-remote-not-carried',
    pins: '§6.9.2: only clocked paths are written; the base is the local copy',
    local: { settings: { notes: { defaultFolder: 'local' } }, fieldClocks: {} },
    remote: { settings: { notes: { spellCheck: true } }, fieldClocks: {} }
  },
  {
    name: 'three-paths-three-branches',
    pins: 'one merge where each path takes a different branch, and one path is clocked on one side only',
    local: {
      settings: { general: { accentColor: 'x', fontFamily: 'serif' }, editor: { width: 'full' } },
      fieldClocks: {
        [PATH]: { [A]: 2 },
        'general.fontFamily': { [A]: 1 },
        'editor.width': { [A]: 1 }
      }
    },
    remote: {
      settings: {
        general: { accentColor: 'y', fontFamily: 'inter' },
        tasks: { showCompleted: true }
      },
      fieldClocks: {
        [PATH]: { [A]: 1 },
        'general.fontFamily': { [B]: 1 },
        'tasks.showCompleted': { [B]: 1 }
      }
    }
  }
]

export function buildSettingsMerge(): Record<string, unknown> {
  const cases = SPECS.map((spec) => ({
    name: spec.name,
    pins: spec.pins,
    local: spec.local,
    remote: spec.remote,
    ...(spec.rustPending ? { rustPending: spec.rustPending } : {}),
    expected: mergeSettingsPayloads(structuredClone(spec.local), structuredClone(spec.remote))
  }))

  return {
    meta: meta({
      class: 'settings-merge',
      chapter: 'docs/protocol/06-vector-clocks-and-field-merge.md',
      implementation: 'packages/sync-client/src/settings-merge.ts',
      caseCount: cases.length
    }),
    cases
  }
}
