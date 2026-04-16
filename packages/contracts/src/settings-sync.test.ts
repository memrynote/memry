/**
 * Settings Sync Contract Tests
 *
 * Zod schema validation coverage for settings-sync.ts.
 * Covers nested synced settings groups + field-level vector clocks.
 */

import { describe, it, expect } from 'vitest'
import {
  SyncedSettingsSchema,
  FieldClockMapSchema,
  SettingsSyncPayloadSchema
} from './settings-sync'

describe('SyncedSettingsSchema', () => {
  it('accepts an empty object (all groups optional)', () => {
    const result = SyncedSettingsSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts a general group with partial fields', () => {
    const result = SyncedSettingsSchema.safeParse({
      general: { theme: 'dark', fontSize: 'large' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid general.theme', () => {
    const result = SyncedSettingsSchema.safeParse({
      general: { theme: 'midnight' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('theme')
    }
  })

  it('rejects invalid general.fontFamily', () => {
    const result = SyncedSettingsSchema.safeParse({
      general: { fontFamily: 'comic-sans' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('fontFamily')
    }
  })

  it('accepts an editor group', () => {
    const result = SyncedSettingsSchema.safeParse({
      editor: {
        width: 'wide',
        spellCheck: false,
        autoSaveDelay: 2000,
        showWordCount: true,
        toolbarMode: 'sticky'
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid editor.width', () => {
    const result = SyncedSettingsSchema.safeParse({
      editor: { width: 'huge' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('width')
    }
  })

  it('rejects invalid editor.toolbarMode', () => {
    const result = SyncedSettingsSchema.safeParse({
      editor: { toolbarMode: 'hidden' }
    })
    expect(result.success).toBe(false)
  })

  it('accepts a tasks group with null defaultProjectId', () => {
    const result = SyncedSettingsSchema.safeParse({
      tasks: { defaultProjectId: null, weekStartDay: 'sunday' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid tasks.defaultSortOrder', () => {
    const result = SyncedSettingsSchema.safeParse({
      tasks: { defaultSortOrder: 'alphabetical' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid tasks.weekStartDay', () => {
    const result = SyncedSettingsSchema.safeParse({
      tasks: { weekStartDay: 'friday' }
    })
    expect(result.success).toBe(false)
  })

  it('accepts a keyboard group with arbitrary override records', () => {
    const result = SyncedSettingsSchema.safeParse({
      keyboard: {
        overrides: {
          'note.save': { key: 's', modifiers: { meta: true } }
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('accepts a notes group', () => {
    const result = SyncedSettingsSchema.safeParse({
      notes: {
        defaultFolder: '/work',
        editorFontSize: 16,
        spellCheck: true
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects notes.editorFontSize when non-numeric', () => {
    const result = SyncedSettingsSchema.safeParse({
      notes: { editorFontSize: 'large' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('editorFontSize')
    }
  })

  it('accepts a sync group with autoSync + interval', () => {
    const result = SyncedSettingsSchema.safeParse({
      sync: { autoSync: false, syncIntervalMinutes: 15 }
    })
    expect(result.success).toBe(true)
  })

  it('rejects sync.autoSync when not boolean', () => {
    const result = SyncedSettingsSchema.safeParse({
      sync: { autoSync: 'yes' }
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('autoSync')
    }
  })

  it('accepts all groups populated together', () => {
    const result = SyncedSettingsSchema.safeParse({
      general: { theme: 'light', accentColor: '#123456' },
      editor: { width: 'narrow' },
      tasks: { weekStartDay: 'monday' },
      keyboard: { overrides: {} },
      notes: { spellCheck: true },
      sync: { autoSync: true }
    })
    expect(result.success).toBe(true)
  })
})

describe('FieldClockMapSchema', () => {
  it('accepts an empty map', () => {
    const result = FieldClockMapSchema.safeParse({})
    expect(result.success).toBe(true)
  })

  it('accepts a map of field → vector clock', () => {
    const result = FieldClockMapSchema.safeParse({
      'general.theme': { 'device-a': 3, 'device-b': 1 },
      'editor.width': { 'device-a': 0 }
    })
    expect(result.success).toBe(true)
  })

  it('rejects a negative tick value in a vector clock', () => {
    const result = FieldClockMapSchema.safeParse({
      'general.theme': { 'device-a': -1 }
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-integer tick value', () => {
    const result = FieldClockMapSchema.safeParse({
      'general.theme': { 'device-a': 1.5 }
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-object clock entry', () => {
    const result = FieldClockMapSchema.safeParse({
      'general.theme': 42
    })
    expect(result.success).toBe(false)
  })
})

describe('SettingsSyncPayloadSchema', () => {
  it('accepts a minimal payload with empty settings + clocks', () => {
    const result = SettingsSyncPayloadSchema.safeParse({
      settings: {},
      fieldClocks: {}
    })
    expect(result.success).toBe(true)
  })

  it('accepts a populated payload', () => {
    const result = SettingsSyncPayloadSchema.safeParse({
      settings: {
        general: { theme: 'dark' },
        editor: { autoSaveDelay: 1000 }
      },
      fieldClocks: {
        'general.theme': { 'device-a': 2 },
        'editor.autoSaveDelay': { 'device-a': 1 }
      }
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing settings field', () => {
    const result = SettingsSyncPayloadSchema.safeParse({ fieldClocks: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('settings')
    }
  })

  it('rejects missing fieldClocks field', () => {
    const result = SettingsSyncPayloadSchema.safeParse({ settings: {} })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('fieldClocks')
    }
  })

  it('rejects invalid nested settings group', () => {
    const result = SettingsSyncPayloadSchema.safeParse({
      settings: { general: { theme: 'not-a-theme' } },
      fieldClocks: {}
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid nested clock value', () => {
    const result = SettingsSyncPayloadSchema.safeParse({
      settings: {},
      fieldClocks: { 'general.theme': { 'device-a': -5 } }
    })
    expect(result.success).toBe(false)
  })
})
