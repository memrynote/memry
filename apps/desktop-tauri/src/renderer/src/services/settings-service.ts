import { SIDEBAR_SORT_DEFAULTS } from '@memry/contracts/sidebar-sort'
import type { SidebarSortMode, SidebarSortSurface } from '@memry/contracts/sidebar-sort'
import type {
  AISettings,
  BackupSettingsDTO,
  EditorSettingsDTO,
  GeneralSettingsDTO,
  GraphSettingsDTO,
  JournalSettings,
  KeyboardShortcutsDTO,
  NoteEditorSettings,
  ShortcutBindingDTO,
  SyncSettingsDTO,
  TabSettings,
  TaskSettingsDTO,
  VoiceTranscriptionSettings
} from '../../../preload/index.d'
import type { GlobalCaptureResult, StickyShortcutResult } from '@memry/contracts/settings-schemas'
import type { CalloutTypeDefinition } from '@memry/editor-schema/callout-types'
import {
  commands,
  events,
  type Value,
  type VoiceModelStatus,
  type VoiceOpenAiKeyStatus,
  type VoiceRecordingReadiness
} from '../../../generated/bindings'
import { sanitizeCalloutTypeDefinitions } from '@memry/editor-schema/callout-types'
import { createLogger } from '../lib/logger'
import { onSyncedRecords } from './sync-service'
import { subscribeToEvent } from './tauri-event'

const log = createLogger('SettingsService')

type Result = { success: boolean; error?: string }

/** Groups whose renderer shape is the stored group, field for field. */
type GroupApi<T> = {
  get: () => Promise<T>
  set: (patch: Partial<T>) => Promise<Result>
}

function failure(error: unknown): Result {
  const message =
    typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error)
  return { success: false, error: message }
}

// A group read is untyped JSON on the wire; the shape is the one core's defaults and the
// settings schemas fix for that group name.
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- T is the caller's assertion about a group's JSON shape
function asShape<T>(value: Value): T {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the group's shape is fixed by core's defaults for its name
  return value as T
}

/** A group on the wire is an object; anything else is a corrupt read and counts as empty. */
async function readObject(name: string): Promise<Record<string, Value>> {
  const value = await commands.settingsGetGroup(name)
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

function group<T>(name: string): GroupApi<T> {
  return {
    get: async () => asShape<T>(await readObject(name)),
    set: async (patch) => {
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a Partial of a JSON object is JSON
        await commands.settingsSetGroup(name, patch as Value)
        return { success: true }
      } catch (error) {
        log.warn(`write of settings group ${name} failed`, error)
        return failure(error)
      }
    }
  }
}

/**
 * Callout types are a synced map (`name` to definition, one clock per entry) that the UI sees as
 * a list, as in Electron's `callout-types-store.ts`: reads sanitize the map into a list.
 */
async function readCalloutTypeList(): Promise<CalloutTypeDefinition[]> {
  return sanitizeCalloutTypeDefinitions(await commands.settingsGetPath('editor.calloutTypes'))
}

/** Writes the difference to the stored map; a removed type is a `null` entry (delete marker). */
async function writeCalloutTypeList(input: unknown): Promise<Result> {
  try {
    const entries = Array.isArray(input)
      ? input.filter((d): d is { name: string } => typeof d?.name === 'string')
      : []
    const next = sanitizeCalloutTypeDefinitions(Object.fromEntries(entries.map((d) => [d.name, d])))
    const before = new Map((await readCalloutTypeList()).map((d) => [d.name, JSON.stringify(d)]))
    const changed: Record<string, Value> = {}
    for (const name of before.keys()) {
      if (!next.some((d) => d.name === name)) changed[name] = null
    }
    for (const definition of next) {
      if (before.get(definition.name) !== JSON.stringify(definition)) {
        changed[definition.name] = { ...definition }
      }
    }
    if (Object.keys(changed).length > 0) await writeField('editor', 'calloutTypes', changed)
    return { success: true }
  } catch (error) {
    return failure(error)
  }
}

async function writeField(groupName: string, field: string, value: Value): Promise<Result> {
  try {
    await commands.settingsSetGroup(groupName, { [field]: value })
    return { success: true }
  } catch (error) {
    return failure(error)
  }
}

async function readField<T>(groupName: string, field: string): Promise<T> {
  return asShape<T>((await readObject(groupName))[field] ?? null)
}

const general = group<GeneralSettingsDTO>('general')
const editor = group<EditorSettingsDTO>('editor')
const tasks = group<TaskSettingsDTO>('tasks')
const keyboard = group<KeyboardShortcutsDTO>('keyboard')
const sync = group<SyncSettingsDTO>('sync')
const backup = group<BackupSettingsDTO>('backup')
const calendar = group<Record<string, unknown>>('calendar')
const features = group<Record<string, unknown>>('features')
const inbox = group<Record<string, unknown>>('inbox')
const sticky = group<Record<string, unknown>>('sticky')
const graph = group<GraphSettingsDTO>('graph')
const journal = group<JournalSettings>('journal')
const tabs = group<TabSettings>('tabs')
const noteEditor = group<NoteEditorSettings>('noteEditor')
const voice = group<VoiceTranscriptionSettings>('voiceTranscription')

/**
 * The `window.api.settings` functions Step 09 owns: every group and flat key core stores. The
 * voice model, readiness, OpenAI key and microphone pane are Step 24's (#3541). The rest of the
 * Electron surface (calendar providers, the terminal command) belongs to the steps that port
 * those features.
 */
export const settingsService = {
  getGeneralSettings: general.get,
  setGeneralSettings: general.set,
  getEditorSettings: editor.get,
  setEditorSettings: editor.set,
  getTaskSettings: tasks.get,
  setTaskSettings: tasks.set,
  getKeyboardSettings: keyboard.get,
  setKeyboardSettings: keyboard.set,
  resetKeyboardSettings: async (): Promise<Result> => {
    try {
      await commands.settingsResetKeyboard()
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  getSyncSettings: sync.get,
  setSyncSettings: sync.set,
  getBackupSettings: backup.get,
  setBackupSettings: backup.set,
  getCalendarSettings: calendar.get,
  setCalendarSettings: calendar.set,
  getFeaturesSettings: features.get,
  setFeaturesSettings: features.set,
  getInboxSettings: inbox.get,
  setInboxSettings: inbox.set,
  getStickySettings: sticky.get,
  setStickySettings: sticky.set,
  getGraphSettings: graph.get,
  setGraphSettings: graph.set,
  getJournalSettings: journal.get,
  setJournalSettings: journal.set,
  getTabSettings: tabs.get,
  setTabSettings: tabs.set,
  getNoteEditorSettings: noteEditor.get,
  setNoteEditorSettings: noteEditor.set,
  registerGlobalCapture: (): Promise<GlobalCaptureResult> =>
    commands.shortcutRegisterGlobalCapture(),
  setGlobalCapture: (binding: ShortcutBindingDTO | null): Promise<GlobalCaptureResult> =>
    commands.shortcutSetGlobalCapture(binding),
  registerStickyShortcut: (): Promise<StickyShortcutResult> => commands.shortcutRegisterSticky(),
  setStickyShortcut: (binding: ShortcutBindingDTO | null): Promise<StickyShortcutResult> =>
    commands.shortcutSetSticky(binding),
  getAISettings: (): Promise<AISettings> => commands.settingsGetAi(),
  setAISettings: async (patch: Partial<AISettings>): Promise<Result> => {
    try {
      await commands.settingsSetAi(patch)
      return { success: true }
    } catch (error) {
      log.warn('write of the AI settings failed', error)
      return failure(error)
    }
  },
  getVoiceTranscriptionSettings: voice.get,
  setVoiceTranscriptionSettings: voice.set,
  getVoiceModelStatus: (): Promise<VoiceModelStatus> => commands.settingsGetVoiceModelStatus(),
  downloadVoiceModel: async (): Promise<Result> => {
    try {
      await commands.settingsDownloadVoiceModel()
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  getVoiceRecordingReadiness: (): Promise<VoiceRecordingReadiness> =>
    commands.settingsGetVoiceRecordingReadiness(),
  getVoiceTranscriptionOpenAIKeyStatus: (): Promise<VoiceOpenAiKeyStatus> =>
    commands.settingsGetVoiceTranscriptionOpenaiKeyStatus(),
  setVoiceTranscriptionOpenAIKey: async (apiKey: string): Promise<Result> => {
    try {
      await commands.settingsSetVoiceTranscriptionOpenaiKey(apiKey)
      return { success: true }
    } catch (error) {
      return failure(error)
    }
  },
  openOsMicrophoneSettings: (): Promise<{ success: boolean }> =>
    commands.settingsOpenOsMicrophoneSettings(),

  getSidebarSortModes: async (): Promise<Record<SidebarSortSurface, SidebarSortMode>> => ({
    ...SIDEBAR_SORT_DEFAULTS,
    ...(await readField<Partial<Record<SidebarSortSurface, SidebarSortMode>>>(
      'sidebar',
      'sortModes'
    ))
  }),
  setSidebarSortMode: async (surface: SidebarSortSurface, mode: SidebarSortMode): Promise<Result> =>
    writeField('sidebar', 'sortModes', { [surface]: mode }),
  getSidebarSectionOrder: async (): Promise<string[]> =>
    (await readField<string[] | null>('sidebar', 'sectionOrder')) ?? [],
  setSidebarSectionOrder: (order: string[]): Promise<Result> =>
    writeField('sidebar', 'sectionOrder', order),
  getSidebarRailOrder: async (): Promise<string[]> =>
    (await readField<string[] | null>('sidebar', 'railOrder')) ?? [],
  setSidebarRailOrder: (order: string[]): Promise<Result> =>
    writeField('sidebar', 'railOrder', order),
  getSidebarNavCollapsed: (): Promise<boolean> => readField('sidebar', 'navCollapsed'),
  setSidebarNavCollapsed: (collapsed: boolean): Promise<Result> =>
    writeField('sidebar', 'navCollapsed', collapsed),
  getSidebarNotesFirst: (): Promise<boolean> => readField('sidebar', 'notesFirst'),
  setSidebarNotesFirst: (notesFirst: boolean): Promise<Result> =>
    writeField('sidebar', 'notesFirst', notesFirst),
  getSidebarShowFiles: (): Promise<boolean> => readField('sidebar', 'showFiles'),
  setSidebarShowFiles: (showFiles: boolean): Promise<Result> =>
    writeField('sidebar', 'showFiles', showFiles),

  getCalloutTypes: readCalloutTypeList,
  setCalloutTypes: writeCalloutTypeList,

  getTagSearches: async (): Promise<unknown[]> => {
    const stored = asShape<{ searches?: unknown[] } | null>(
      await commands.settingsGetLocal('tagSearches')
    )
    return stored?.searches ?? []
  },
  setTagSearches: async (searches: unknown[]): Promise<unknown[]> => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the searches are JSON built by the tag search UI
    await commands.settingsSetLocal('tagSearches', { searches } as Value)
    return searches
  },
  getGraphViews: async (): Promise<unknown> =>
    (await commands.settingsGetLocal('graphViews')) ?? {},
  setGraphViews: async (patch: unknown): Promise<unknown> => {
    const current = asShape<Record<string, Value>>(
      (await commands.settingsGetLocal('graphViews')) ?? {}
    )
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the patch is JSON built by the graph view UI
    const next = { ...current, ...(patch as Record<string, Value>) }
    await commands.settingsSetLocal('graphViews', next)
    return next
  }
}

/** The `{ key, value }` event the renderer's listeners were written against. */
export interface SettingsChange {
  key: string
  value: unknown
}

/**
 * The groups announced after a pulled settings record: the ones Electron's settings handler
 * broadcast (`propagateMergedSettings`), and `keyboard`. Electron applied no synced rebinds;
 * core writes them here, and `use-keyboard-settings` and `shortcut-bindings` apply a peer's
 * rebinds live from this announcement. `tasks`, `notes`, `sync` and `readwise` stay silent, as
 * in Electron.
 */
const PULLED_GROUPS = ['general', 'editor', 'calendar', 'keyboard', 'inbox', 'journal', 'sidebar']

/**
 * Subscribes to settings writes. Rust announces `{ key, fields }` (names only); each listener
 * gets the Electron shape back by reading the written fields, with `sidebar` fields and the
 * callout types addressed as `group.field` the way those listeners filter. A pulled settings
 * record names no group, so `PULLED_GROUPS` are read and announced whole, once per pulled page
 * for all listeners together (`announcePulledGroups`).
 */
export function onSettingsChanged(callback: (change: SettingsChange) => void): () => void {
  const tell = async (key: string, fields: string[]): Promise<void> => {
    try {
      for (const change of await changesFor(key, fields)) callback(change)
    } catch (error) {
      log.warn(`settings change for ${key} could not be read`, error)
    }
  }
  const stopWrites = subscribeToEvent(events.settingsChangedEvent, ({ key, fields }) => {
    void tell(key, fields)
  })
  const stopPulled = joinPulledPages(callback)
  return () => {
    stopWrites()
    stopPulled()
  }
}

const pulledListeners = new Set<(change: SettingsChange) => void>()
let stopPulledPages: (() => void) | null = null

/**
 * Every `onSettingsChanged` caller shares one subscription to pulled settings pages, started by
 * the first and stopped with the last. About 100 listeners would otherwise each read every group
 * for each page, and Electron sent one broadcast.
 */
function joinPulledPages(callback: (change: SettingsChange) => void): () => void {
  const listener = (change: SettingsChange): void => {
    try {
      callback(change)
    } catch (error) {
      log.warn('a settings listener threw', error)
    }
  }
  pulledListeners.add(listener)
  stopPulledPages ??= onSyncedRecords(['settings'], announcePulledGroups)
  return () => {
    pulledListeners.delete(listener)
    if (pulledListeners.size > 0) return
    stopPulledPages?.()
    stopPulledPages = null
  }
}

/** Reads each pulled group once and hands the result to every listener subscribed by then. */
function announcePulledGroups(): void {
  for (const name of PULLED_GROUPS) {
    void changesFor(name, [])
      .then((changes) => {
        for (const listener of pulledListeners) {
          for (const change of changes) listener(change)
        }
      })
      .catch((error: unknown) => log.warn(`settings change for ${name} could not be read`, error))
  }
}

async function changesFor(key: string, fields: string[]): Promise<SettingsChange[]> {
  // The AI switches are flat local keys, not a group (`settings_set_ai`).
  const current: Record<string, Value> =
    key === 'ai' ? await commands.settingsGetAi() : await readObject(key)
  // No field names: the whole group changed.
  const whole = fields.length === 0
  const names = whole ? Object.keys(current) : fields
  if (key === 'sidebar') {
    return names.map((field) => ({ key: `sidebar.${field}`, value: current[field] ?? null }))
  }
  const changes: SettingsChange[] = []
  // Core keeps `calloutTypes` out of the editor group read, so a whole editor announce reads them
  // itself, as Electron emitted them for every pulled map (`settings-handler.ts:196-199`).
  if (whole ? key === 'editor' : fields.includes('calloutTypes')) {
    changes.push({ key: 'editor.calloutTypes', value: await readCalloutTypeList() })
  }
  const patchFields = names.filter((field) => field in current)
  if (whole || patchFields.length > 0) {
    changes.push({
      key,
      value: Object.fromEntries(patchFields.map((field) => [field, current[field]]))
    })
  }
  return changes
}

/** `settings:openSection`: the menu and deep links ask for a settings section. */
export function onSettingsOpenRequested(callback: (section: string) => void): () => void {
  return subscribeToEvent(events.settingsOpenSectionEvent, (event) => callback(event.section))
}
