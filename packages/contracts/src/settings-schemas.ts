/**
 * Settings Zod Schemas
 *
 * Validation schemas for all settings groups.
 * Each group has a schema, defaults constant, and inferred type.
 *
 * @module contracts/settings-schemas
 */

import { z } from 'zod'
import { LocaleSchema } from './locale-api'
import { FONT_SIZE_PX_DEFAULT, FONT_SIZE_PX_MAX, FONT_SIZE_PX_MIN } from './font-size'
import { ZOOM_FACTOR_DEFAULT, ZOOM_FACTOR_MAX, ZOOM_FACTOR_MIN } from './app-zoom'

// ============================================================================
// General Settings
// ============================================================================

export const GeneralSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'white', 'system']),
  fontSize: z.enum(['small', 'medium', 'large']),
  /**
   * The interface root font size in pixels, and the authoritative one. The
   * legacy `fontSize` bucket is kept written in step with it so an older app
   * version, or a device that has not updated yet, still lands approximately
   * where the user put the slider instead of snapping back to medium.
   */
  fontSizePx: z.number().int().min(FONT_SIZE_PX_MIN).max(FONT_SIZE_PX_MAX),
  fontFamily: z.enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter']),
  /**
   * The name of a font installed on this machine, applied ahead of `fontFamily`
   * when it is non-empty. Free text: the app cannot ship a list of every font a
   * machine has, and a name that is not installed simply loses the CSS font
   * stack race, so the interface falls back to `fontFamily` (or the system
   * default) with no extra handling. Empty means "no custom font".
   */
  customFontFamily: z.string().max(64),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  startOnBoot: z.boolean(),
  language: LocaleSchema,
  onboardingCompleted: z.boolean(),
  createInSelectedFolder: z.boolean(),
  /**
   * Whether clicking a page in the sidebar opens a new tab. Off means the click
   * reuses the active (unpinned) tab, so browsing ten notes leaves one tab.
   *
   * Defaults to `false`. It shipped defaulting to `true`, which made a browsing
   * pass spawn a tab per click; existing installs are moved to `false` once by
   * `main/settings/flip-open-pages-in-new-tab.ts`, which leaves an explicit
   * user choice alone.
   */
  openPagesInNewTab: z.boolean(),
  /**
   * Whether closing the main window hides it to a system tray icon instead of
   * closing it. Off by default; the tray icon only exists while this is on.
   *
   * A machine whose desktop has no tray host (some Linux sessions) keeps the
   * normal close behavior even with this on, because hiding a window that
   * nothing can restore would leave the app running and unreachable.
   */
  minimizeToTray: z.boolean(),
  clockFormat: z.enum(['12h', '24h']),
  dateFormat: z.enum(['MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY']),
  /**
   * The factor the whole interface renders at. Deliberately per-install: it
   * compensates for the physical display in front of the user, so a 27" desktop
   * and a 13" laptop each keep their own value. It is neither synced nor
   * carried when a vault moves to another machine.
   */
  zoomFactor: z.number().min(ZOOM_FACTOR_MIN).max(ZOOM_FACTOR_MAX)
})

export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>

export const DEFAULT_ACCENT_COLOR = '#f97316'

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  theme: 'white',
  fontSize: 'medium',
  fontSizePx: FONT_SIZE_PX_DEFAULT,
  fontFamily: 'system',
  customFontFamily: '',
  accentColor: DEFAULT_ACCENT_COLOR,
  startOnBoot: false,
  language: 'en',
  onboardingCompleted: false,
  createInSelectedFolder: true,
  openPagesInNewTab: false,
  minimizeToTray: false,
  clockFormat: '12h',
  dateFormat: 'DD.MM.YYYY',
  zoomFactor: ZOOM_FACTOR_DEFAULT
}

// ============================================================================
// Editor Settings
// ============================================================================

export const EditorSettingsSchema = z.object({
  // Legacy widths (narrow/medium/wide) coerce to 'normal' so installs written
  // by older app versions keep working; only 'full' is treated as full width.
  width: z.preprocess((v) => (v === 'full' ? 'full' : 'normal'), z.enum(['normal', 'full'])),
  toolbarMode: z.enum(['floating', 'sticky']),
  spellCheck: z.boolean(),
  /**
   * Invert PDF pages while the app is in a dark theme. A viewing preference
   * rather than a property of any one file, so it lives with the settings the
   * vault carries instead of in a tab's view state.
   */
  pdfAdaptToTheme: z.boolean()
})

export type EditorSettings = z.infer<typeof EditorSettingsSchema>

export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
  width: 'normal',
  toolbarMode: 'floating',
  // Off by default: the editor has no misspelling suggestions in its context
  // menu, so squiggles would be noise the user cannot act on.
  spellCheck: false,
  // Off by default: inverting turns coloured charts and photographs into
  // negatives, so it has to be the user's choice rather than a surprise.
  pdfAdaptToTheme: false
}

// ============================================================================
// Task Settings
// ============================================================================

export const TaskSettingsSchema = z.object({
  defaultProjectId: z.string().nullable(),
  defaultSortOrder: z.enum(['manual', 'dueDate', 'priority', 'createdAt']),
  // Which scope the Tasks page opens on when a tab has no saved view state.
  // `tomorrow` and `next7` are additive: older values stay valid, and the
  // renderer coerces anything it does not recognise back to `all`.
  defaultView: z.enum(['today', 'tomorrow', 'next7', 'all']),
  staleInboxDays: z.number().int().min(1).max(90)
})

export type TaskSettings = z.infer<typeof TaskSettingsSchema>

export const TASK_SETTINGS_DEFAULTS: TaskSettings = {
  defaultProjectId: null,
  defaultSortOrder: 'manual',
  defaultView: 'all',
  staleInboxDays: 7
}

// ============================================================================
// Keyboard Shortcuts
// ============================================================================

export const ShortcutBindingSchema = z.object({
  key: z.string().min(1),
  modifiers: z.object({
    meta: z.boolean().optional(),
    ctrl: z.boolean().optional(),
    shift: z.boolean().optional(),
    alt: z.boolean().optional()
  })
})

export type ShortcutBinding = z.infer<typeof ShortcutBindingSchema>

export const KeyboardShortcutsSchema = z.object({
  overrides: z.record(z.string(), ShortcutBindingSchema),
  globalCapture: ShortcutBindingSchema.nullable()
})

export type KeyboardShortcuts = z.infer<typeof KeyboardShortcutsSchema>

export const KEYBOARD_SHORTCUTS_DEFAULTS: KeyboardShortcuts = {
  overrides: {},
  globalCapture: null
}

// ============================================================================
// Sync Settings
// ============================================================================

export const SyncSettingsSchema = z.object({
  enabled: z.boolean(),
  autoSync: z.boolean(),
  /**
   * Whether attachments referenced by pulled notes are fetched in the
   * background (the eager path and the failure re-driver). `false` means
   * on-demand only: nothing downloads until something explicitly asks for the
   * file. Additive — settings blobs written by older versions have no key, and
   * every reader treats only an explicit `false` as opting out, so existing
   * installs keep today's eager behaviour.
   */
  attachmentAutoDownload: z.boolean()
})

export type SyncSettings = z.infer<typeof SyncSettingsSchema>

export const SYNC_SETTINGS_DEFAULTS: SyncSettings = {
  enabled: true,
  autoSync: true,
  attachmentAutoDownload: true
}

// ============================================================================
// AI Settings
// ============================================================================

export const AISettingsSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(['local', 'openai', 'anthropic']),
  model: z.string().nullable()
})

export type AISettings = z.infer<typeof AISettingsSchema>

export const AI_SETTINGS_DEFAULTS: AISettings = {
  enabled: false,
  provider: 'local',
  model: null
}

// ============================================================================
// Voice Transcription Settings
// ============================================================================

export const VoiceTranscriptionSettingsSchema = z.object({
  provider: z.enum(['local', 'openai']),
  memoNameMode: z.enum(['transcript', 'timestamp', 'none'])
})

export type VoiceTranscriptionSettings = z.infer<typeof VoiceTranscriptionSettingsSchema>

export const VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS: VoiceTranscriptionSettings = {
  provider: 'local',
  memoNameMode: 'transcript'
}

// ============================================================================
// Calendar Settings (Day Panel dot source + click behavior)
// ============================================================================

export const CalendarSettingsSchema = z.object({
  dayCellClickBehavior: z.enum(['journal', 'calendar']),
  calendarPageClickOverride: z.enum(['inherit', 'journal', 'calendar']),
  weekStartDay: z.enum(['sunday', 'monday']),
  // When true, every regular note is shown on the calendar as an all-day chip on
  // its creation day (read-side projection only — no date is written to the note).
  showNotesOnCalendar: z.boolean()
})

export type CalendarSettings = z.infer<typeof CalendarSettingsSchema>

export const CALENDAR_SETTINGS_DEFAULTS: CalendarSettings = {
  dayCellClickBehavior: 'journal',
  calendarPageClickOverride: 'calendar',
  weekStartDay: 'monday',
  // Off by default: notes stay off the calendar until the user opts in (this
  // global toggle, or a per-date-property calendar toggle on the note).
  showNotesOnCalendar: false
}

// ============================================================================
// Calendar — Google Settings (M2)
// ============================================================================

export const CalendarGoogleSettingsSchema = z.object({
  defaultTargetCalendarId: z.string().nullable(),
  onboardingCompleted: z.boolean(),
  promoteConfirmDismissed: z.boolean(),
  // false = one-way (inbound-only): pull Google events into memrynote but never
  // push memrynote events out to Google.
  pushEventsToGoogle: z.boolean(),
  // Google Workspace Limited Use: whether the AI agent may read Google-synced
  // calendar events. null = the user has not been asked yet; anything other
  // than an explicit true keeps Google events out of every agent read.
  // Defaulted, not required: settings written before this shipped have no such
  // key, and those installs must land on "not asked" rather than fail to parse.
  agentReadEventsConsent: z.boolean().nullable().default(null)
})

export type CalendarGoogleSettings = z.infer<typeof CalendarGoogleSettingsSchema>

export const CALENDAR_GOOGLE_SETTINGS_DEFAULTS: CalendarGoogleSettings = {
  defaultTargetCalendarId: null,
  onboardingCompleted: false,
  promoteConfirmDismissed: false,
  pushEventsToGoogle: true,
  agentReadEventsConsent: null
}

// ============================================================================
// Features Settings (optional module toggles)
// ============================================================================

export const FeaturesSettingsSchema = z.object({
  home: z.boolean(),
  inbox: z.boolean(),
  journal: z.boolean(),
  tasks: z.boolean(),
  calendar: z.boolean(),
  graph: z.boolean(),
  // Settings toggle (in FEATURE_KEYS), default ON since the M7 rollout: spatial
  // canvas surface. An install that stored `false` keeps it off — the stored
  // value wins over the default.
  spatialCanvas: z.boolean()
})

export type FeaturesSettings = z.infer<typeof FeaturesSettingsSchema>

export const FEATURES_SETTINGS_DEFAULTS: FeaturesSettings = {
  home: true,
  inbox: true,
  journal: true,
  tasks: true,
  calendar: true,
  graph: true,
  spatialCanvas: true
}

// ============================================================================
// Backup Settings
// ============================================================================

export const BackupSettingsSchema = z.object({
  autoBackup: z.boolean(),
  frequencyHours: z.union([z.literal(1), z.literal(6), z.literal(12), z.literal(24)]),
  maxBackups: z.number().int().min(1).max(50),
  lastBackupAt: z.string().nullable()
})

export type BackupSettings = z.infer<typeof BackupSettingsSchema>

export const BACKUP_SETTINGS_DEFAULTS: BackupSettings = {
  autoBackup: false,
  frequencyHours: 24,
  maxBackups: 5,
  lastBackupAt: null
}

// ============================================================================
// Inbox Settings (daily review reminder)
// ============================================================================

/**
 * 24h "HH:MM" wall-clock pattern for the inbox review-reminder time. Shared by
 * this Zod schema, the renderer input guard, and the main-process scheduler's
 * parser so the three never drift. Groups 1 and 2 capture hours and minutes.
 */
export const REVIEW_REMINDER_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

export const InboxSettingsSchema = z.object({
  // Optional daily reminder to process the inbox in one calm pass.
  reviewReminderEnabled: z.boolean(),
  // Local wall-clock time, 24h "HH:MM".
  reviewReminderTime: z.string().regex(REVIEW_REMINDER_TIME_PATTERN),
  // How an image lands in the notes it is filed to (#807): as a note attachment
  // that stays out of the sidebar, or as a file in the tree the note links to.
  // Defaulted, not required — settings written by older builds must still parse.
  imageFilingMode: z.enum(['embed', 'link']).default('embed'),
  // Once the user answers the filing prompt with "remember", it stops being
  // asked and `imageFilingMode` is used silently. Changeable here afterwards.
  imageFilingModeRemembered: z.boolean().default(false)
})

export type InboxSettings = z.infer<typeof InboxSettingsSchema>

export const INBOX_SETTINGS_DEFAULTS: InboxSettings = {
  reviewReminderEnabled: false,
  reviewReminderTime: '18:00',
  imageFilingMode: 'embed',
  imageFilingModeRemembered: false
}

// ============================================================================
// Account Info (read-only, derived from auth state)
// ============================================================================

export const AccountInfoSchema = z.object({
  email: z.string().email(),
  authProvider: z.enum(['email', 'google', 'github']),
  createdAt: z.string(),
  storageUsedBytes: z.number(),
  storageLimitBytes: z.number(),
  avatarUrl: z.string().nullable()
})

export type AccountInfo = z.infer<typeof AccountInfoSchema>

// ============================================================================
// Tag Info (aggregated, read-only)
// ============================================================================

export const TagInfoSchema = z.object({
  name: z.string(),
  count: z.number().int(),
  color: z.string().optional()
})

export type TagInfo = z.infer<typeof TagInfoSchema>

// ============================================================================
// Data Operations
// ============================================================================

export const ExportRequestSchema = z.object({
  format: z.enum(['json', 'markdown']),
  destPath: z.string().min(1)
})

export type ExportRequest = z.infer<typeof ExportRequestSchema>

export const ImportRequestSchema = z.object({
  sourcePath: z.string().min(1),
  format: z.enum(['notion', 'obsidian', 'json'])
})

export type ImportRequest = z.infer<typeof ImportRequestSchema>

export const ImportResultSchema = z.object({
  imported: z.number().int(),
  skipped: z.number().int()
})

export type ImportResult = z.infer<typeof ImportResultSchema>

// ============================================================================
// Recovery Key
// ============================================================================

export const GetRecoveryKeyRequestSchema = z.object({
  reAuthToken: z.string().min(1)
})

export type GetRecoveryKeyRequest = z.infer<typeof GetRecoveryKeyRequestSchema>

// ============================================================================
// AI Key Management
// ============================================================================

export const SetApiKeyRequestSchema = z.object({
  provider: z.enum(['openai', 'anthropic']),
  key: z.string().min(1)
})

export type SetApiKeyRequest = z.infer<typeof SetApiKeyRequestSchema>

export const TestConnectionRequestSchema = z.object({
  provider: z.enum(['local', 'openai', 'anthropic'])
})

export type TestConnectionRequest = z.infer<typeof TestConnectionRequestSchema>

export const TestConnectionResultSchema = z.object({
  valid: z.boolean(),
  error: z.string().optional()
})

export type TestConnectionResult = z.infer<typeof TestConnectionResultSchema>
