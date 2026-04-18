/**
 * Settings Schemas Contract Tests
 *
 * Zod schema validation coverage for settings-schemas.ts.
 * Tests cover default values, valid inputs, and invalid input rejection paths.
 */

import { describe, it, expect } from 'vitest'
import {
  GeneralSettingsSchema,
  GENERAL_SETTINGS_DEFAULTS,
  EditorSettingsSchema,
  EDITOR_SETTINGS_DEFAULTS,
  TaskSettingsSchema,
  TASK_SETTINGS_DEFAULTS,
  ShortcutBindingSchema,
  KeyboardShortcutsSchema,
  KEYBOARD_SHORTCUTS_DEFAULTS,
  SyncSettingsSchema,
  SYNC_SETTINGS_DEFAULTS,
  AISettingsSchema,
  AI_SETTINGS_DEFAULTS,
  VoiceTranscriptionSettingsSchema,
  VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS,
  BackupSettingsSchema,
  BACKUP_SETTINGS_DEFAULTS,
  AccountInfoSchema,
  TagInfoSchema,
  ExportRequestSchema,
  ImportRequestSchema,
  ImportResultSchema,
  GetRecoveryKeyRequestSchema,
  SetApiKeyRequestSchema,
  TestConnectionRequestSchema,
  TestConnectionResultSchema,
  CalendarGoogleSettingsSchema,
  CALENDAR_GOOGLE_SETTINGS_DEFAULTS
} from './settings-schemas'

describe('GeneralSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = GeneralSettingsSchema.safeParse(GENERAL_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('accepts a custom accent color with 6-digit hex', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      accentColor: '#aAbBcC'
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid theme enum', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      theme: 'midnight'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('theme')
    }
  })

  it('rejects invalid fontFamily enum', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      fontFamily: 'comic-sans'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('fontFamily')
    }
  })

  it('rejects malformed accent color', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      accentColor: 'blue'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('accentColor')
    }
  })

  it('rejects language shorter than 2 chars', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      language: 'e'
    })
    expect(result.success).toBe(false)
  })

  it('rejects language longer than 5 chars', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      language: 'en-US-x'
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid clockFormat enum', () => {
    const result = GeneralSettingsSchema.safeParse({
      ...GENERAL_SETTINGS_DEFAULTS,
      clockFormat: '48h'
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing required boolean field', () => {
    const { startOnBoot: _omit, ...rest } = GENERAL_SETTINGS_DEFAULTS
    const result = GeneralSettingsSchema.safeParse(rest)
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('startOnBoot')
    }
  })
})

describe('EditorSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = EditorSettingsSchema.safeParse(EDITOR_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('rejects width outside enum', () => {
    const result = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      width: 'full'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('width')
    }
  })

  it('rejects negative autoSaveDelay', () => {
    const result = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      autoSaveDelay: -1
    })
    expect(result.success).toBe(false)
  })

  it('rejects autoSaveDelay above 30000', () => {
    const result = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      autoSaveDelay: 30001
    })
    expect(result.success).toBe(false)
  })

  it('accepts autoSaveDelay at boundaries', () => {
    const low = EditorSettingsSchema.safeParse({ ...EDITOR_SETTINGS_DEFAULTS, autoSaveDelay: 0 })
    expect(low.success).toBe(true)
    const high = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      autoSaveDelay: 30000
    })
    expect(high.success).toBe(true)
  })

  it('rejects non-integer autoSaveDelay', () => {
    const result = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      autoSaveDelay: 1500.5
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid toolbarMode enum', () => {
    const result = EditorSettingsSchema.safeParse({
      ...EDITOR_SETTINGS_DEFAULTS,
      toolbarMode: 'pinned'
    })
    expect(result.success).toBe(false)
  })
})

describe('TaskSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = TaskSettingsSchema.safeParse(TASK_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('accepts a string defaultProjectId', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      defaultProjectId: 'proj-1'
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid defaultSortOrder', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      defaultSortOrder: 'alphabetical'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('defaultSortOrder')
    }
  })

  it('rejects invalid weekStartDay', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      weekStartDay: 'wednesday'
    })
    expect(result.success).toBe(false)
  })

  it('rejects staleInboxDays below 1', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      staleInboxDays: 0
    })
    expect(result.success).toBe(false)
  })

  it('rejects staleInboxDays above 90', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      staleInboxDays: 91
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer staleInboxDays', () => {
    const result = TaskSettingsSchema.safeParse({
      ...TASK_SETTINGS_DEFAULTS,
      staleInboxDays: 5.5
    })
    expect(result.success).toBe(false)
  })
})

describe('ShortcutBindingSchema', () => {
  it('accepts a single key with no modifiers', () => {
    const result = ShortcutBindingSchema.safeParse({
      key: 'k',
      modifiers: {}
    })
    expect(result.success).toBe(true)
  })

  it('accepts a binding with full modifier set', () => {
    const result = ShortcutBindingSchema.safeParse({
      key: 'Enter',
      modifiers: { meta: true, ctrl: false, shift: true, alt: false }
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty key', () => {
    const result = ShortcutBindingSchema.safeParse({
      key: '',
      modifiers: {}
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('key')
    }
  })

  it('rejects missing modifiers object', () => {
    const result = ShortcutBindingSchema.safeParse({ key: 'k' })
    expect(result.success).toBe(false)
  })
})

describe('KeyboardShortcutsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = KeyboardShortcutsSchema.safeParse(KEYBOARD_SHORTCUTS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('accepts overrides map keyed by command name', () => {
    const result = KeyboardShortcutsSchema.safeParse({
      overrides: {
        'note.save': { key: 's', modifiers: { meta: true } }
      },
      globalCapture: { key: 'n', modifiers: { meta: true, shift: true } }
    })
    expect(result.success).toBe(true)
  })

  it('rejects override with invalid binding', () => {
    const result = KeyboardShortcutsSchema.safeParse({
      overrides: { 'note.save': { key: '', modifiers: {} } },
      globalCapture: null
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing globalCapture field', () => {
    const result = KeyboardShortcutsSchema.safeParse({ overrides: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('globalCapture')
    }
  })
})

describe('SyncSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = SyncSettingsSchema.safeParse(SYNC_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean enabled', () => {
    const result = SyncSettingsSchema.safeParse({ enabled: 'yes', autoSync: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('enabled')
    }
  })

  it('rejects missing autoSync field', () => {
    const result = SyncSettingsSchema.safeParse({ enabled: true })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('autoSync')
    }
  })
})

describe('AISettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = AISettingsSchema.safeParse(AI_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('accepts a named model', () => {
    const result = AISettingsSchema.safeParse({
      enabled: true,
      provider: 'openai',
      model: 'gpt-4o-mini'
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid provider', () => {
    const result = AISettingsSchema.safeParse({
      enabled: true,
      provider: 'mistral',
      model: null
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('provider')
    }
  })
})

describe('VoiceTranscriptionSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = VoiceTranscriptionSettingsSchema.safeParse(VOICE_TRANSCRIPTION_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('rejects unsupported provider', () => {
    const result = VoiceTranscriptionSettingsSchema.safeParse({ provider: 'whisper-cloud' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('provider')
    }
  })
})

describe('BackupSettingsSchema', () => {
  it('accepts the shipped default payload', () => {
    const result = BackupSettingsSchema.safeParse(BACKUP_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('accepts each allowed frequencyHours literal', () => {
    for (const frequencyHours of [1, 6, 12, 24] as const) {
      const result = BackupSettingsSchema.safeParse({
        ...BACKUP_SETTINGS_DEFAULTS,
        frequencyHours
      })
      expect(result.success).toBe(true)
    }
  })

  it('rejects frequencyHours outside the literal set', () => {
    const result = BackupSettingsSchema.safeParse({
      ...BACKUP_SETTINGS_DEFAULTS,
      frequencyHours: 3
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('frequencyHours')
    }
  })

  it('rejects maxBackups below 1', () => {
    const result = BackupSettingsSchema.safeParse({
      ...BACKUP_SETTINGS_DEFAULTS,
      maxBackups: 0
    })
    expect(result.success).toBe(false)
  })

  it('rejects maxBackups above 50', () => {
    const result = BackupSettingsSchema.safeParse({
      ...BACKUP_SETTINGS_DEFAULTS,
      maxBackups: 51
    })
    expect(result.success).toBe(false)
  })

  it('accepts a stored lastBackupAt string', () => {
    const result = BackupSettingsSchema.safeParse({
      ...BACKUP_SETTINGS_DEFAULTS,
      lastBackupAt: '2026-04-16T10:00:00Z'
    })
    expect(result.success).toBe(true)
  })
})

describe('AccountInfoSchema', () => {
  const baseAccount = {
    email: 'test@example.com',
    authProvider: 'email' as const,
    createdAt: '2026-01-01T00:00:00Z',
    storageUsedBytes: 1024,
    storageLimitBytes: 1048576,
    avatarUrl: null
  }

  it('accepts a well-formed account payload', () => {
    const result = AccountInfoSchema.safeParse(baseAccount)
    expect(result.success).toBe(true)
  })

  it('rejects an invalid email', () => {
    const result = AccountInfoSchema.safeParse({ ...baseAccount, email: 'not-an-email' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('email')
    }
  })

  it('rejects an unsupported authProvider', () => {
    const result = AccountInfoSchema.safeParse({ ...baseAccount, authProvider: 'apple' })
    expect(result.success).toBe(false)
  })
})

describe('TagInfoSchema', () => {
  it('accepts tag with name and count', () => {
    const result = TagInfoSchema.safeParse({ name: 'work', count: 12 })
    expect(result.success).toBe(true)
  })

  it('accepts tag with optional color', () => {
    const result = TagInfoSchema.safeParse({ name: 'work', count: 12, color: '#ff0000' })
    expect(result.success).toBe(true)
  })

  it('rejects non-integer count', () => {
    const result = TagInfoSchema.safeParse({ name: 'work', count: 1.5 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('count')
    }
  })
})

describe('ExportRequestSchema', () => {
  it('accepts valid export request', () => {
    const result = ExportRequestSchema.safeParse({
      format: 'json',
      destPath: '/tmp/export.json'
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid format', () => {
    const result = ExportRequestSchema.safeParse({
      format: 'xml',
      destPath: '/tmp/export.xml'
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty destPath', () => {
    const result = ExportRequestSchema.safeParse({ format: 'json', destPath: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('destPath')
    }
  })
})

describe('ImportRequestSchema', () => {
  it('accepts a valid import request', () => {
    const result = ImportRequestSchema.safeParse({
      sourcePath: '/tmp/export.json',
      format: 'notion'
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty sourcePath', () => {
    const result = ImportRequestSchema.safeParse({ sourcePath: '', format: 'json' })
    expect(result.success).toBe(false)
  })

  it('rejects unsupported format', () => {
    const result = ImportRequestSchema.safeParse({
      sourcePath: '/tmp/data',
      format: 'evernote'
    })
    expect(result.success).toBe(false)
  })
})

describe('ImportResultSchema', () => {
  it('accepts integer counts', () => {
    const result = ImportResultSchema.safeParse({ imported: 5, skipped: 2 })
    expect(result.success).toBe(true)
  })

  it('rejects non-integer counts', () => {
    const result = ImportResultSchema.safeParse({ imported: 5.5, skipped: 2 })
    expect(result.success).toBe(false)
  })

  it('rejects missing skipped field', () => {
    const result = ImportResultSchema.safeParse({ imported: 5 })
    expect(result.success).toBe(false)
  })
})

describe('GetRecoveryKeyRequestSchema', () => {
  it('accepts a non-empty reAuthToken', () => {
    const result = GetRecoveryKeyRequestSchema.safeParse({ reAuthToken: 'token-123' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty reAuthToken', () => {
    const result = GetRecoveryKeyRequestSchema.safeParse({ reAuthToken: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('reAuthToken')
    }
  })
})

describe('SetApiKeyRequestSchema', () => {
  it('accepts a valid provider + key', () => {
    const result = SetApiKeyRequestSchema.safeParse({
      provider: 'openai',
      key: 'sk-test-123'
    })
    expect(result.success).toBe(true)
  })

  it('rejects unsupported provider (local is read-only)', () => {
    const result = SetApiKeyRequestSchema.safeParse({
      provider: 'local',
      key: 'sk-test-123'
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('provider')
    }
  })

  it('rejects empty key', () => {
    const result = SetApiKeyRequestSchema.safeParse({ provider: 'openai', key: '' })
    expect(result.success).toBe(false)
  })
})

describe('TestConnectionRequestSchema', () => {
  it('accepts each supported provider', () => {
    for (const provider of ['local', 'openai', 'anthropic'] as const) {
      const result = TestConnectionRequestSchema.safeParse({ provider })
      expect(result.success).toBe(true)
    }
  })

  it('rejects unsupported provider', () => {
    const result = TestConnectionRequestSchema.safeParse({ provider: 'mistral' })
    expect(result.success).toBe(false)
  })
})

describe('TestConnectionResultSchema', () => {
  it('accepts a successful result without an error field', () => {
    const result = TestConnectionResultSchema.safeParse({ valid: true })
    expect(result.success).toBe(true)
  })

  it('accepts a failed result with an error message', () => {
    const result = TestConnectionResultSchema.safeParse({
      valid: false,
      error: 'invalid api key'
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean valid', () => {
    const result = TestConnectionResultSchema.safeParse({ valid: 'yes' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('valid')
    }
  })
})

describe('CalendarGoogleSettingsSchema (M2)', () => {
  it('accepts the shipped defaults', () => {
    const result = CalendarGoogleSettingsSchema.safeParse(CALENDAR_GOOGLE_SETTINGS_DEFAULTS)
    expect(result.success).toBe(true)
  })

  it('exposes sensible defaults for a fresh install', () => {
    // #given — the default payload
    const { defaultTargetCalendarId, onboardingCompleted, promoteConfirmDismissed } =
      CALENDAR_GOOGLE_SETTINGS_DEFAULTS

    // #then — no default calendar picked, onboarding pending, promote dialog armed
    expect(defaultTargetCalendarId).toBeNull()
    expect(onboardingCompleted).toBe(false)
    expect(promoteConfirmDismissed).toBe(false)
  })

  it('accepts a user who picked a default calendar during onboarding', () => {
    const result = CalendarGoogleSettingsSchema.safeParse({
      defaultTargetCalendarId: 'primary@group.calendar.google.com',
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })
    expect(result.success).toBe(true)
  })

  it('accepts a null defaultTargetCalendarId after onboarding is done (user skipped)', () => {
    const result = CalendarGoogleSettingsSchema.safeParse({
      defaultTargetCalendarId: null,
      onboardingCompleted: true,
      promoteConfirmDismissed: false
    })
    expect(result.success).toBe(true)
  })

  it('rejects non-string defaultTargetCalendarId', () => {
    const result = CalendarGoogleSettingsSchema.safeParse({
      ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
      defaultTargetCalendarId: 42
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('defaultTargetCalendarId')
    }
  })

  it('rejects non-boolean onboardingCompleted', () => {
    const result = CalendarGoogleSettingsSchema.safeParse({
      ...CALENDAR_GOOGLE_SETTINGS_DEFAULTS,
      onboardingCompleted: 'yes'
    })
    expect(result.success).toBe(false)
  })
})
