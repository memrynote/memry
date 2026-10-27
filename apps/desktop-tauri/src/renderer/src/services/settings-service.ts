import { SIDEBAR_SORT_DEFAULTS } from '@memry/contracts/sidebar-sort'
import type { SidebarSortMode, SidebarSortSurface } from '@memry/contracts/sidebar-sort'
import type {
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
import type { GlobalCaptureResult } from '@memry/contracts/settings-schemas'
import type { CalloutTypeDefinition } from '@memry/editor-schema/callout-types'
import { commands, events, type Value } from '../../../generated/bindings'
import { sanitizeCalloutTypeDefinitions } from '@memry/editor-schema/callout-types'
import { createLogger } from '../lib/logger'
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
 * rest of the Electron surface (AI, calendar providers, the voice model, the terminal command and
 * the global shortcuts) belongs to the steps that port those features.
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
  getVoiceTranscriptionSettings: voice.get,
  setVoiceTranscriptionSettings: voice.set,

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
 * Subscribes to settings writes. Rust announces `{ key, fields }` (names only); each listener
 * gets the Electron shape back by reading the written fields, with `sidebar` fields and the
 * callout types addressed as `group.field` the way those listeners filter.
 */
export function onSettingsChanged(callback: (change: SettingsChange) => void): () => void {
  return subscribeToEvent(events.settingsChangedEvent, (event) => {
    void announce(event.key, event.fields, callback).catch((error: unknown) =>
      log.warn(`settings change for ${event.key} could not be read`, error)
    )
  })
}

async function announce(
  key: string,
  fields: string[],
  callback: (change: SettingsChange) => void
): Promise<void> {
  const current = await readObject(key)
  if (key === 'sidebar') {
    for (const field of fields) callback({ key: `sidebar.${field}`, value: current[field] ?? null })
    return
  }
  const patchFields = fields.filter((field) => field in current)
  if (fields.includes('calloutTypes')) {
    callback({
      key: 'editor.calloutTypes',
      value: await readCalloutTypeList()
    })
  }
  if (fields.length > 0 && patchFields.length === 0) return
  const patch = Object.fromEntries(
    (fields.length === 0 ? Object.keys(current) : patchFields).map((field) => [
      field,
      current[field]
    ])
  )
  callback({ key, value: patch })
}

/** `settings:openSection`: the menu and deep links ask for a settings section. */
export function onSettingsOpenRequested(callback: (section: string) => void): () => void {
  return subscribeToEvent(events.settingsOpenSectionEvent, (event) => callback(event.section))
}
