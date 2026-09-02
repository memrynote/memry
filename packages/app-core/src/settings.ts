import { asc, eq } from 'drizzle-orm'
import { settings } from '@memry/db-schema/data-schema'
import type { DrizzleDb as DataDb } from '@memry/db-schema/drizzle-db'

export interface SettingRecord {
  key: string
  value: unknown
  modifiedAt: string
}

export interface AiSettings {
  enabled: boolean
}

export interface SettingsGroupRecord {
  name: SettingsGroupName
  value: Record<string, unknown>
}

export type SettingsGroupName =
  | 'general'
  | 'editor'
  | 'tasks'
  | 'keyboard'
  | 'sync'
  | 'backup'
  | 'graph'
  | 'calendar'
  | 'calendar.google'
  | 'voiceTranscription'
  | 'journal'
  | 'tabs'
  | 'noteEditor'

export interface SettingsService {
  list(): Promise<SettingRecord[]>
  get(key: string): Promise<SettingRecord | null>
  set(key: string, value: unknown): Promise<SettingRecord>
  delete(key: string): Promise<boolean>
  groups(): Promise<SettingsGroupRecord[]>
  getGroup(name: string): Promise<Record<string, unknown>>
  setGroup(name: string, updates: Record<string, unknown>): Promise<Record<string, unknown>>
  ai(): Promise<AiSettings>
  setAi(settings: Partial<AiSettings>): Promise<AiSettings>
}

const aiEnabledKey = 'ai.enabled'

const settingsKeys = {
  journalDefaultTemplate: 'journal.defaultTemplate',
  journalShowSchedule: 'journal.showSchedule',
  journalShowTasks: 'journal.showTasks',
  journalShowAiConnections: 'journal.showAIConnections',
  journalShowStatsFooter: 'journal.showStatsFooter',
  tabRestoreSessionOnStart: 'tabs.restoreSessionOnStart',
  tabCloseButton: 'tabs.tabCloseButton',
  noteEditorToolbarMode: 'noteEditor.toolbarMode'
} as const

const settingsGroupDefaults: Record<SettingsGroupName, Record<string, unknown>> = {
  general: {
    theme: 'white',
    fontSize: 'medium',
    fontSizePx: 16,
    fontFamily: 'system',
    accentColor: '#6366f1',
    startOnBoot: false,
    language: 'en',
    onboardingCompleted: false,
    createInSelectedFolder: true,
    openPagesInNewTab: false,
    minimizeToTray: false,
    clockFormat: '12h',
    dateFormat: 'DD.MM.YYYY'
  },
  editor: {
    width: 'normal',
    toolbarMode: 'floating'
  },
  tasks: {
    defaultProjectId: null,
    defaultSortOrder: 'manual',
    staleInboxDays: 7
  },
  keyboard: {
    overrides: {},
    globalCapture: null
  },
  sync: {
    enabled: true,
    autoSync: true
  },
  backup: {
    autoBackup: false,
    frequencyHours: 24,
    maxBackups: 5,
    lastBackupAt: null
  },
  graph: {
    layout: 'forceatlas2',
    showLabels: false,
    showEdgeLabels: false,
    animateLayout: true,
    showTagEdges: false
  },
  calendar: {
    dayCellClickBehavior: 'journal',
    calendarPageClickOverride: 'calendar',
    weekStartDay: 'monday'
  },
  'calendar.google': {
    defaultTargetCalendarId: null,
    onboardingCompleted: false,
    promoteConfirmDismissed: false
  },
  voiceTranscription: {
    provider: 'local',
    memoNameMode: 'transcript'
  },
  journal: {
    defaultTemplate: null,
    showSchedule: true,
    showTasks: true,
    showAIConnections: true,
    showStatsFooter: false
  },
  tabs: {
    restoreSessionOnStart: true,
    tabCloseButton: 'hover'
  },
  noteEditor: {
    toolbarMode: 'floating'
  }
}

const jsonSettingsGroupNames = new Set<SettingsGroupName>([
  'general',
  'editor',
  'tasks',
  'keyboard',
  'sync',
  'backup',
  'graph',
  'calendar',
  'calendar.google',
  'voiceTranscription'
])

function nowIso(): string {
  return new Date().toISOString()
}

function parseSettingValue(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function toSetting(row: typeof settings.$inferSelect): SettingRecord {
  return {
    key: row.key,
    value: parseSettingValue(row.value),
    modifiedAt: row.modifiedAt
  }
}

function normalizeGroupName(name: string): SettingsGroupName {
  if (name in settingsGroupDefaults) return name as SettingsGroupName
  throw new Error(`Unknown settings group: ${name}`)
}

function readRawSetting(dataDb: DataDb, key: string): string | null {
  return (
    dataDb.select({ value: settings.value }).from(settings).where(eq(settings.key, key)).get()
      ?.value ?? null
  )
}

function writeRawSetting(dataDb: DataDb, key: string, value: string): void {
  const modifiedAt = nowIso()
  dataDb
    .insert(settings)
    .values({ key, value, modifiedAt })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, modifiedAt }
    })
    .run()
}

function deleteRawSetting(dataDb: DataDb, key: string): void {
  dataDb.delete(settings).where(eq(settings.key, key)).run()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function createSettingsService(dataDb: DataDb): SettingsService {
  const readJsonGroup = (groupName: SettingsGroupName): Record<string, unknown> => {
    const defaults = settingsGroupDefaults[groupName]
    const raw = readRawSetting(dataDb, groupName)
    if (!raw) return { ...defaults }

    try {
      const parsed = JSON.parse(raw) as unknown
      if (!isPlainObject(parsed)) {
        dataDb.delete(settings).where(eq(settings.key, groupName)).run()
        return { ...defaults }
      }
      return { ...defaults, ...parsed }
    } catch {
      dataDb.delete(settings).where(eq(settings.key, groupName)).run()
      return { ...defaults }
    }
  }

  const readScalarGroup = (groupName: SettingsGroupName): Record<string, unknown> => {
    switch (groupName) {
      case 'journal':
        return {
          defaultTemplate: readRawSetting(dataDb, settingsKeys.journalDefaultTemplate),
          showSchedule: readRawSetting(dataDb, settingsKeys.journalShowSchedule) !== 'false',
          showTasks: readRawSetting(dataDb, settingsKeys.journalShowTasks) !== 'false',
          showAIConnections:
            readRawSetting(dataDb, settingsKeys.journalShowAiConnections) !== 'false',
          showStatsFooter: readRawSetting(dataDb, settingsKeys.journalShowStatsFooter) === 'true'
        }
      case 'tabs': {
        const restoreSessionOnStart = readRawSetting(dataDb, settingsKeys.tabRestoreSessionOnStart)
        return {
          restoreSessionOnStart:
            restoreSessionOnStart !== null
              ? restoreSessionOnStart === 'true'
              : settingsGroupDefaults.tabs.restoreSessionOnStart,
          tabCloseButton:
            readRawSetting(dataDb, settingsKeys.tabCloseButton) ??
            settingsGroupDefaults.tabs.tabCloseButton
        }
      }
      case 'noteEditor':
        return {
          toolbarMode:
            readRawSetting(dataDb, settingsKeys.noteEditorToolbarMode) ??
            settingsGroupDefaults.noteEditor.toolbarMode
        }
      default:
        return readJsonGroup(groupName)
    }
  }

  const readGroup = (name: string): Record<string, unknown> => {
    const groupName = normalizeGroupName(name)
    return jsonSettingsGroupNames.has(groupName)
      ? readJsonGroup(groupName)
      : readScalarGroup(groupName)
  }

  const writeScalarGroup = (
    groupName: SettingsGroupName,
    updates: Record<string, unknown>
  ): boolean => {
    switch (groupName) {
      case 'journal':
        if ('defaultTemplate' in updates) {
          if (updates.defaultTemplate === null) {
            deleteRawSetting(dataDb, settingsKeys.journalDefaultTemplate)
          } else if (typeof updates.defaultTemplate === 'string') {
            writeRawSetting(dataDb, settingsKeys.journalDefaultTemplate, updates.defaultTemplate)
          }
        }
        if (typeof updates.showSchedule === 'boolean') {
          writeRawSetting(
            dataDb,
            settingsKeys.journalShowSchedule,
            updates.showSchedule ? 'true' : 'false'
          )
        }
        if (typeof updates.showTasks === 'boolean') {
          writeRawSetting(
            dataDb,
            settingsKeys.journalShowTasks,
            updates.showTasks ? 'true' : 'false'
          )
        }
        if (typeof updates.showAIConnections === 'boolean') {
          writeRawSetting(
            dataDb,
            settingsKeys.journalShowAiConnections,
            updates.showAIConnections ? 'true' : 'false'
          )
        }
        if (typeof updates.showStatsFooter === 'boolean') {
          writeRawSetting(
            dataDb,
            settingsKeys.journalShowStatsFooter,
            updates.showStatsFooter ? 'true' : 'false'
          )
        }
        return true
      case 'tabs':
        if (typeof updates.restoreSessionOnStart === 'boolean') {
          writeRawSetting(
            dataDb,
            settingsKeys.tabRestoreSessionOnStart,
            updates.restoreSessionOnStart ? 'true' : 'false'
          )
        }
        if (typeof updates.tabCloseButton === 'string') {
          writeRawSetting(dataDb, settingsKeys.tabCloseButton, updates.tabCloseButton)
        }
        return true
      case 'noteEditor':
        if (typeof updates.toolbarMode === 'string') {
          writeRawSetting(dataDb, settingsKeys.noteEditorToolbarMode, updates.toolbarMode)
        }
        return true
      default:
        return false
    }
  }

  return {
    async list() {
      return dataDb.select().from(settings).orderBy(asc(settings.key)).all().map(toSetting)
    },

    async get(key) {
      const row = dataDb.select().from(settings).where(eq(settings.key, key)).get()
      return row ? toSetting(row) : null
    },

    async set(key, value) {
      const modifiedAt = nowIso()
      const serialized = JSON.stringify(value)
      dataDb
        .insert(settings)
        .values({ key, value: serialized, modifiedAt })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: serialized, modifiedAt }
        })
        .run()

      const setting = await this.get(key)
      if (!setting) throw new Error(`Setting not found after write: ${key}`)
      return setting
    },

    async delete(key) {
      dataDb.delete(settings).where(eq(settings.key, key)).run()
      return true
    },

    async groups() {
      return (Object.keys(settingsGroupDefaults) as SettingsGroupName[]).map((name) => ({
        name,
        value: readGroup(name)
      }))
    },

    async getGroup(name) {
      return readGroup(name)
    },

    async setGroup(name, updates) {
      const groupName = normalizeGroupName(name)
      if (!jsonSettingsGroupNames.has(groupName) && writeScalarGroup(groupName, updates)) {
        return readGroup(groupName)
      }
      const updated = { ...readGroup(groupName), ...updates }
      await this.set(groupName, updated)
      return updated
    },

    async ai() {
      const enabled = readRawSetting(dataDb, aiEnabledKey)
      return { enabled: enabled !== 'false' }
    },

    async setAi(updates) {
      const current = await this.ai()
      const next = { ...current, ...updates }
      if (updates.enabled !== undefined) {
        writeRawSetting(dataDb, aiEnabledKey, updates.enabled ? 'true' : 'false')
      }
      return next
    }
  }
}
