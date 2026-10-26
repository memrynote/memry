/**
 * Class: settings groups (`settings-groups.json`).
 *
 * What the Rust core's `domain/app_settings` must agree with desktop on: every
 * group's default object, which of its fields sync (wire path `<group>.<field>`),
 * which fields are maps with one clock per entry and what an entry key may be,
 * and the numeric ranges. The defaults and the syncable lists come from the
 * production constants of `settings-schemas.ts`. A group whose defaults desktop
 * keeps as a private literal (`DEFAULT_TAB_SETTINGS`, the journal and sidebar
 * readers) is spelled here from that code and named in `source`.
 *
 * Determinism: D1. Every value is a constant.
 */
import { CALLOUT_TYPE_NAME_REGEX } from '../../../editor-schema/src/blocks/callout-types'
import { AI_INLINE_SETTINGS_DEFAULTS } from '../../src/ai-inline-channels'
import { ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN } from '../../src/app-zoom'
import { FONT_SIZE_PX_MAX, FONT_SIZE_PX_MIN } from '../../src/font-size'
import { GRAPH_SETTINGS_DEFAULTS } from '../../src/graph-api'
import {
  BACKUP_SETTINGS_DEFAULTS,
  CALENDAR_SETTINGS_DEFAULTS,
  EDITOR_SETTINGS_DEFAULTS,
  EDITOR_SYNCABLE_FIELDS,
  FEATURES_SETTINGS_DEFAULTS,
  GENERAL_SETTINGS_DEFAULTS,
  GENERAL_SYNCABLE_FIELDS,
  INBOX_SETTINGS_DEFAULTS,
  INBOX_SYNCABLE_FIELDS,
  KEYBOARD_SHORTCUTS_DEFAULTS,
  STICKY_SETTINGS_DEFAULTS,
  SYNC_SETTINGS_DEFAULTS,
  TASK_SETTINGS_DEFAULTS,
  VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS
} from '../../src/settings-schemas'
import { SIDEBAR_SORT_SURFACES } from '../../src/sidebar-sort'
import { meta } from './shared'

interface MapSpec {
  name: string
  /** Keys that must be accepted and rejected as an entry of the map. */
  validEntries: string[]
  invalidEntries: string[]
  /** Whether the group's read shows the map (`editor.calloutTypes` is read by path). */
  inGroup: boolean
}

interface GroupSpec {
  defaults: Record<string, unknown>
  syncable: readonly string[]
  maps: MapSpec[]
  source: string
}

const SETTINGS_SCHEMAS = 'packages/contracts/src/settings-schemas.ts'
const HANDLERS = 'apps/desktop/src/main/ipc/settings-handlers.ts'

// Keys of `journal.weekdayTemplates`: JS `getDay()`, `isWeekdayKey` in
// apps/desktop/src/main/settings/journal-template-keys.ts.
const WEEKDAYS = ['0', '1', '2', '3', '4', '5', '6']
const CALLOUT_VALID = ['note', 'my-type', 'a', 'x_1', 'a'.repeat(32)]
const CALLOUT_INVALID = ['', 'Note', '1a', 'a.b', 'a b', '-a', 'a'.repeat(33)]

const GROUPS: Record<string, GroupSpec> = {
  general: {
    defaults: { ...GENERAL_SETTINGS_DEFAULTS },
    syncable: GENERAL_SYNCABLE_FIELDS,
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  editor: {
    defaults: { ...EDITOR_SETTINGS_DEFAULTS },
    syncable: EDITOR_SYNCABLE_FIELDS,
    maps: [
      {
        name: 'calloutTypes',
        validEntries: CALLOUT_VALID.filter((key) => CALLOUT_TYPE_NAME_REGEX.test(key)),
        invalidEntries: CALLOUT_INVALID.filter((key) => !CALLOUT_TYPE_NAME_REGEX.test(key)),
        inGroup: false
      }
    ],
    source: SETTINGS_SCHEMAS
  },
  tasks: {
    defaults: { ...TASK_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  keyboard: {
    defaults: { ...KEYBOARD_SHORTCUTS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  sync: {
    defaults: { ...SYNC_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  backup: {
    defaults: { ...BACKUP_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  calendar: {
    defaults: { ...CALENDAR_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  features: {
    defaults: { ...FEATURES_SETTINGS_DEFAULTS },
    // features-settings-sync.ts: every flag of the group syncs.
    syncable: Object.keys(FEATURES_SETTINGS_DEFAULTS),
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  inbox: {
    defaults: { ...INBOX_SETTINGS_DEFAULTS },
    syncable: INBOX_SYNCABLE_FIELDS,
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  sticky: {
    defaults: { ...STICKY_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  graph: {
    defaults: { ...GRAPH_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: 'packages/contracts/src/graph-api.ts'
  },
  voiceTranscription: {
    defaults: { ...VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: SETTINGS_SCHEMAS
  },
  'ai-inline': {
    defaults: { ...AI_INLINE_SETTINGS_DEFAULTS },
    syncable: [],
    maps: [],
    source: 'packages/contracts/src/ai-inline-channels.ts'
  },
  journal: {
    // getJournalSettings(): the no-vault literal, and the readers of the flat rows.
    defaults: {
      defaultTemplate: null,
      weekdayTemplates: {},
      showSchedule: true,
      showTasks: true,
      showAIConnections: true,
      showStatsFooter: false
    },
    syncable: ['defaultTemplate'],
    maps: [
      {
        name: 'weekdayTemplates',
        validEntries: WEEKDAYS,
        invalidEntries: ['', '7', '-1', '01', 'a', '10'],
        inGroup: true
      }
    ],
    source: HANDLERS
  },
  tabs: {
    defaults: { restoreSessionOnStart: true, tabCloseButton: 'hover' },
    syncable: [],
    maps: [],
    source: HANDLERS
  },
  noteEditor: {
    defaults: { toolbarMode: 'floating' },
    syncable: [],
    maps: [],
    source: HANDLERS
  },
  sidebar: {
    // sidebar-*-store.ts: absent means the order the app always had, the nav
    // expanded, folders before notes, files shown.
    defaults: {
      sortModes: {},
      sectionOrder: null,
      railOrder: null,
      navCollapsed: false,
      notesFirst: false,
      showFiles: true
    },
    syncable: ['sectionOrder', 'railOrder', 'navCollapsed', 'notesFirst', 'showFiles'],
    maps: [
      {
        name: 'sortModes',
        validEntries: [...SIDEBAR_SORT_SURFACES],
        invalidEntries: ['', 'notes', 'Collections', 'tags.x'],
        inGroup: true
      }
    ],
    source: 'apps/desktop/src/main/settings/sidebar-*-store.ts'
  }
}

export function buildSettingsGroups(): Record<string, unknown> {
  return {
    meta: meta({
      class: 'settings-groups',
      implementation: 'crates/memry-core/src/domain/app_settings',
      groupCount: Object.keys(GROUPS).length
    }),
    ranges: {
      'general.fontSizePx': { min: FONT_SIZE_PX_MIN, max: FONT_SIZE_PX_MAX },
      'general.zoomFactor': { min: ZOOM_FACTOR_MIN, max: ZOOM_FACTOR_MAX }
    },
    groups: GROUPS
  }
}
