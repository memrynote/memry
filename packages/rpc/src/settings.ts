import type {
  BackupSettings,
  CalendarGoogleSettings,
  EditorSettings,
  GeneralSettings,
  KeyboardShortcuts,
  SyncSettings,
  TaskSettings,
  VoiceTranscriptionSettings
} from '../../contracts/src/settings-schemas.ts'
import { SettingsChannels } from '../../contracts/src/ipc-channels.ts'
import {
  defineDomain,
  defineEvent,
  defineMethod,
  type RpcClient,
  type RpcSubscriptions
} from './schema.ts'

export interface JournalSettings {
  defaultTemplate: string | null
  showSchedule: boolean
  showTasks: boolean
  showAIConnections: boolean
  showStatsFooter: boolean
}

export interface AISettings {
  enabled: boolean
}

export interface AIModelStatus {
  name: string
  dimension: number
  loaded: boolean
  loading: boolean
  error: string | null
  embeddingCount?: number
}

export interface VoiceModelStatus {
  name: string
  downloaded: boolean
  loaded: boolean
  loading: boolean
  error: string | null
}

export interface VoiceRecordingReadiness {
  ready: boolean
  provider: 'local' | 'openai'
  reason?: 'missing-model' | 'missing-api-key'
  message?: string
}

export interface VoiceTranscriptionOpenAIKeyStatus {
  hasApiKey: boolean
}

export interface TabSettings {
  previewMode: boolean
  restoreSessionOnStart: boolean
  tabCloseButton: 'always' | 'hover' | 'active'
}

export interface NoteEditorSettings {
  toolbarMode: 'floating' | 'sticky'
}

export interface GraphSettings {
  layout: 'forceatlas2' | 'circular' | 'random'
  nodeSizing: 'uniform' | 'by-connections' | 'by-word-count'
  showLabels: boolean
  linkDistance: number
  repulsionStrength: number
  showEdgeLabels: boolean
  animateLayout: boolean
  showTagEdges: boolean
}

export interface SettingsChangedEvent {
  key: string
  value: unknown
}

export interface EmbeddingProgressEvent {
  current: number
  total: number
  phase: 'downloading' | 'loading' | 'ready' | 'error' | 'scanning' | 'embedding' | 'complete'
  status?: string
  progress?: number
}

export interface VoiceModelProgressEvent {
  current?: number
  total?: number
  progress?: number
  phase: 'downloading' | 'loading' | 'ready' | 'error'
  status?: string
}

type SuccessResponse = Promise<{ success: boolean; error?: string }>

export const settingsRpc = defineDomain({
  name: 'settings',
  methods: {
    get: defineMethod<(key: string) => Promise<string | null>>({
      channel: SettingsChannels.invoke.GET,
      params: ['key']
    }),
    set: defineMethod<(key: string, value: string) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET,
      params: ['key', 'value'],
      invokeArgs: ['{ key, value }']
    }),
    getJournalSettings: defineMethod<() => Promise<JournalSettings>>({
      channel: SettingsChannels.invoke.GET_JOURNAL_SETTINGS
    }),
    setJournalSettings: defineMethod<(settings: Partial<JournalSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_JOURNAL_SETTINGS,
      params: ['settings']
    }),
    getAISettings: defineMethod<() => Promise<AISettings>>({
      channel: SettingsChannels.invoke.GET_AI_SETTINGS
    }),
    setAISettings: defineMethod<(settings: Partial<AISettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_AI_SETTINGS,
      params: ['settings']
    }),
    getVoiceTranscriptionSettings: defineMethod<() => Promise<VoiceTranscriptionSettings>>({
      channel: SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_SETTINGS
    }),
    setVoiceTranscriptionSettings: defineMethod<
      (settings: Partial<VoiceTranscriptionSettings>) => SuccessResponse
    >({
      channel: SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_SETTINGS,
      params: ['settings']
    }),
    getVoiceModelStatus: defineMethod<() => Promise<VoiceModelStatus>>({
      channel: SettingsChannels.invoke.GET_VOICE_MODEL_STATUS
    }),
    downloadVoiceModel: defineMethod<
      () => Promise<{ success: boolean; error?: string; message?: string }>
    >({
      channel: SettingsChannels.invoke.DOWNLOAD_VOICE_MODEL
    }),
    getVoiceRecordingReadiness: defineMethod<() => Promise<VoiceRecordingReadiness>>({
      channel: SettingsChannels.invoke.GET_VOICE_RECORDING_READINESS
    }),
    getVoiceTranscriptionOpenAIKeyStatus: defineMethod<
      () => Promise<VoiceTranscriptionOpenAIKeyStatus>
    >({
      channel: SettingsChannels.invoke.GET_VOICE_TRANSCRIPTION_OPENAI_KEY_STATUS
    }),
    setVoiceTranscriptionOpenAIKey: defineMethod<(apiKey: string) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_VOICE_TRANSCRIPTION_OPENAI_KEY,
      params: ['apiKey'],
      invokeArgs: ['{ apiKey }']
    }),
    getAIModelStatus: defineMethod<() => Promise<AIModelStatus>>({
      channel: SettingsChannels.invoke.GET_AI_MODEL_STATUS
    }),
    loadAIModel: defineMethod<
      () => Promise<{ success: boolean; error?: string; message?: string }>
    >({
      channel: SettingsChannels.invoke.LOAD_AI_MODEL
    }),
    reindexEmbeddings: defineMethod<
      () => Promise<{ success: boolean; computed?: number; skipped?: number; error?: string }>
    >({
      channel: SettingsChannels.invoke.REINDEX_EMBEDDINGS
    }),
    getTabSettings: defineMethod<() => Promise<TabSettings>>({
      channel: SettingsChannels.invoke.GET_TAB_SETTINGS
    }),
    setTabSettings: defineMethod<(settings: Partial<TabSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_TAB_SETTINGS,
      params: ['settings']
    }),
    getNoteEditorSettings: defineMethod<() => Promise<NoteEditorSettings>>({
      channel: SettingsChannels.invoke.GET_NOTE_EDITOR_SETTINGS
    }),
    setNoteEditorSettings: defineMethod<(settings: Partial<NoteEditorSettings>) => SuccessResponse>(
      {
        channel: SettingsChannels.invoke.SET_NOTE_EDITOR_SETTINGS,
        params: ['settings']
      }
    ),
    getStartupThemeSync: defineMethod<() => GeneralSettings['theme']>({
      channel: SettingsChannels.sync.GET_STARTUP_THEME,
      mode: 'sync',
      implementation: `() => {
        const raw = invokeSync(${JSON.stringify(SettingsChannels.sync.GET_STARTUP_THEME)}) as
          | 'light'
          | 'dark'
          | 'white'
          | 'system'
          | { theme?: 'light' | 'dark' | 'white' | 'system' }
          | null
          | undefined
        return typeof raw === 'string' ? raw : raw?.theme ?? 'system'
      }`
    }),
    getGeneralSettings: defineMethod<() => Promise<GeneralSettings>>({
      channel: SettingsChannels.invoke.GET_GENERAL_SETTINGS
    }),
    setGeneralSettings: defineMethod<(settings: Partial<GeneralSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_GENERAL_SETTINGS,
      params: ['settings']
    }),
    getEditorSettings: defineMethod<() => Promise<EditorSettings>>({
      channel: SettingsChannels.invoke.GET_EDITOR_SETTINGS
    }),
    setEditorSettings: defineMethod<(settings: Partial<EditorSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_EDITOR_SETTINGS,
      params: ['settings']
    }),
    getTaskSettings: defineMethod<() => Promise<TaskSettings>>({
      channel: SettingsChannels.invoke.GET_TASK_SETTINGS
    }),
    setTaskSettings: defineMethod<(settings: Partial<TaskSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_TASK_SETTINGS,
      params: ['settings']
    }),
    getKeyboardSettings: defineMethod<() => Promise<KeyboardShortcuts>>({
      channel: SettingsChannels.invoke.GET_KEYBOARD_SETTINGS
    }),
    setKeyboardSettings: defineMethod<(settings: Partial<KeyboardShortcuts>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_KEYBOARD_SETTINGS,
      params: ['settings']
    }),
    resetKeyboardSettings: defineMethod<() => SuccessResponse>({
      channel: SettingsChannels.invoke.RESET_KEYBOARD_SETTINGS
    }),
    getSyncSettings: defineMethod<() => Promise<SyncSettings>>({
      channel: SettingsChannels.invoke.GET_SYNC_SETTINGS
    }),
    setSyncSettings: defineMethod<(settings: Partial<SyncSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_SYNC_SETTINGS,
      params: ['settings']
    }),
    getBackupSettings: defineMethod<() => Promise<BackupSettings>>({
      channel: SettingsChannels.invoke.GET_BACKUP_SETTINGS
    }),
    setBackupSettings: defineMethod<(settings: Partial<BackupSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_BACKUP_SETTINGS,
      params: ['settings']
    }),
    getGraphSettings: defineMethod<() => Promise<GraphSettings>>({
      channel: SettingsChannels.invoke.GET_GRAPH_SETTINGS
    }),
    setGraphSettings: defineMethod<(settings: Partial<GraphSettings>) => SuccessResponse>({
      channel: SettingsChannels.invoke.SET_GRAPH_SETTINGS,
      params: ['settings']
    }),
    getCalendarGoogleSettings: defineMethod<() => Promise<CalendarGoogleSettings>>({
      channel: SettingsChannels.invoke.GET_CALENDAR_GOOGLE_SETTINGS
    }),
    setCalendarGoogleSettings: defineMethod<
      (settings: Partial<CalendarGoogleSettings>) => SuccessResponse
    >({
      channel: SettingsChannels.invoke.SET_CALENDAR_GOOGLE_SETTINGS,
      params: ['settings']
    }),
    registerGlobalCapture: defineMethod<
      () => Promise<{
        success: boolean
        registered: boolean
        permissionRequired?: boolean
        error?: string
      }>
    >({
      channel: SettingsChannels.invoke.REGISTER_GLOBAL_CAPTURE
    })
  },
  events: {
    onSettingsChanged: defineEvent<SettingsChangedEvent>(SettingsChannels.events.CHANGED),
    onEmbeddingProgress: defineEvent<EmbeddingProgressEvent>(
      SettingsChannels.events.EMBEDDING_PROGRESS
    ),
    onVoiceModelProgress: defineEvent<VoiceModelProgressEvent>(
      SettingsChannels.events.VOICE_MODEL_PROGRESS
    ),
    onSettingsOpenRequested: defineEvent<string>(SettingsChannels.events.OPEN_SECTION)
  }
})

export type SettingsClientAPI = RpcClient<typeof settingsRpc>
export type SettingsSubscriptions = RpcSubscriptions<typeof settingsRpc>
