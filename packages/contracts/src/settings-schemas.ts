/**
 * Settings Zod Schemas
 *
 * Validation schemas for all settings groups.
 * Each group has a schema, defaults constant, and inferred type.
 *
 * @module contracts/settings-schemas
 */

import { z } from 'zod'

// ============================================================================
// General Settings
// ============================================================================

export const GeneralSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'white', 'system']),
  fontSize: z.enum(['small', 'medium', 'large']),
  fontFamily: z.enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter']),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  startOnBoot: z.boolean(),
  language: z.string().min(2).max(5),
  onboardingCompleted: z.boolean(),
  createInSelectedFolder: z.boolean()
})

export type GeneralSettings = z.infer<typeof GeneralSettingsSchema>

export const GENERAL_SETTINGS_DEFAULTS: GeneralSettings = {
  theme: 'system',
  fontSize: 'medium',
  fontFamily: 'system',
  accentColor: '#6366f1',
  startOnBoot: false,
  language: 'en',
  onboardingCompleted: false,
  createInSelectedFolder: true
}

// ============================================================================
// Editor Settings
// ============================================================================

export const EditorSettingsSchema = z.object({
  width: z.enum(['narrow', 'medium', 'wide']),
  spellCheck: z.boolean(),
  autoSaveDelay: z.number().int().min(0).max(30000),
  showWordCount: z.boolean(),
  toolbarMode: z.enum(['floating', 'sticky'])
})

export type EditorSettings = z.infer<typeof EditorSettingsSchema>

export const EDITOR_SETTINGS_DEFAULTS: EditorSettings = {
  width: 'medium',
  spellCheck: true,
  autoSaveDelay: 1000,
  showWordCount: false,
  toolbarMode: 'floating'
}

// ============================================================================
// Task Settings
// ============================================================================

export const TaskSettingsSchema = z.object({
  defaultProjectId: z.string().nullable(),
  defaultSortOrder: z.enum(['manual', 'dueDate', 'priority', 'createdAt']),
  weekStartDay: z.enum(['sunday', 'monday']),
  staleInboxDays: z.number().int().min(1).max(90)
})

export type TaskSettings = z.infer<typeof TaskSettingsSchema>

export const TASK_SETTINGS_DEFAULTS: TaskSettings = {
  defaultProjectId: null,
  defaultSortOrder: 'manual',
  weekStartDay: 'monday',
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
  autoSync: z.boolean()
})

export type SyncSettings = z.infer<typeof SyncSettingsSchema>

export const SYNC_SETTINGS_DEFAULTS: SyncSettings = {
  enabled: true,
  autoSync: true
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
  provider: z.enum(['local', 'openai'])
})

export type VoiceTranscriptionSettings = z.infer<typeof VoiceTranscriptionSettingsSchema>

export const VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS: VoiceTranscriptionSettings = {
  provider: 'local'
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
