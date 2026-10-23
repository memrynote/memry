/**
 * Settings Sync Contract Tests
 *
 * Zod schema validation coverage for settings-sync.ts.
 * Covers nested synced settings groups + field-level vector clocks.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  SyncedSettingsSchema,
  FieldClockMapSchema,
  SettingsSyncPayloadSchema
} from './settings-sync'

describe('SyncedSettingsSchema', () => {
  it('keeps the features group, including a flag only a newer build knows', () => {
    const features = { home: true, journal: false, spatialCanvas: false, quickSwitcher: false }
    expect(SyncedSettingsSchema.parse({ features }).features).toEqual(features)
  })

  describe('readwise group', () => {
    const readwise = {
      rootFolder: 'Reading',
      folderLayout: 'flat',
      categories: { books: true, supplementals: false },
      cadence: 'daily',
      syncDeviceId: 'device-a'
    }

    it('keeps the group, including a field only a newer build knows', () => {
      expect(SyncedSettingsSchema.parse({ readwise }).readwise).toEqual(readwise)
    })

    it('keeps the claim and a cleared claim, which is an explicit null (§13.4)', () => {
      const claim = { syncDeviceId: 'device-a', syncDeviceName: 'Desk Mac' }
      expect(SyncedSettingsSchema.parse({ readwise: claim }).readwise).toEqual(claim)
      const cleared = { syncDeviceId: null, syncDeviceName: null }
      expect(SyncedSettingsSchema.parse({ readwise: cleared }).readwise).toEqual(cleared)
      expect(SyncedSettingsSchema.safeParse({ readwise: { syncDeviceId: 7 } }).success).toBe(false)
    })

    it('keeps a layout and cadence value only a newer build knows', () => {
      const parsed = SyncedSettingsSchema.parse({
        readwise: { folderLayout: 'by-year', cadence: 'weekly' }
      })
      expect(parsed.readwise).toEqual({ folderLayout: 'by-year', cadence: 'weekly' })
    })

    it('parses under the schema an older build ships, which has no readwise group', () => {
      const olderBuild = SyncedSettingsSchema.omit({ readwise: true })
      const payload = { general: { theme: 'dark' }, readwise }

      const parsed = olderBuild.safeParse(payload)

      expect(parsed.success).toBe(true)
      expect(parsed.data).toEqual({ general: { theme: 'dark' } })
    })

    it('keeps the Reader switches, and a build that does not model them keeps them too', () => {
      const reader = { readerDocuments: true, readerFullText: false }
      expect(SyncedSettingsSchema.parse({ readwise: { ...reader } }).readwise).toEqual(reader)
      expect(SyncedSettingsSchema.safeParse({ readwise: { readerDocuments: 'on' } }).success).toBe(
        false
      )

      // The group as the build before #1420 shipped it: `catchall` carries the new leaves.
      const before1420 = z
        .object({
          cadence: z.string().optional(),
          categories: z.object({}).catchall(z.unknown()).optional()
        })
        .catchall(z.unknown())
      expect(before1420.parse({ cadence: 'daily', ...reader })).toEqual({
        cadence: 'daily',
        ...reader
      })
    })

    it('keeps the journal switch, and a build before it keeps it with the rest of the group', () => {
      const group = { cadence: 'daily', readerDocuments: true, journalHighlights: true }
      expect(SyncedSettingsSchema.parse({ readwise: { ...group } }).readwise).toEqual(group)
      expect(
        SyncedSettingsSchema.safeParse({ readwise: { journalHighlights: 'on' } }).success
      ).toBe(false)

      // The group as the build before #3476 shipped it: `catchall` carries the leaf.
      const before3476 = z
        .object({ cadence: z.string().optional(), readerDocuments: z.boolean().optional() })
        .catchall(z.unknown())
      expect(before3476.parse(group)).toEqual(group)
    })

    it('rejects a non-boolean category switch', () => {
      expect(
        SyncedSettingsSchema.safeParse({ readwise: { categories: { books: 'yes' } } }).success
      ).toBe(false)
    })
  })

  it('rejects a non-boolean features flag', () => {
    expect(SyncedSettingsSchema.safeParse({ features: { journal: 'off' } }).success).toBe(false)
  })

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
        toolbarMode: 'sticky'
      }
    })
    expect(result.success).toBe(true)
  })

  it('accepts custom callout types per name, a deleted one as null, and ignores shape in entries', () => {
    const result = SyncedSettingsSchema.safeParse({
      editor: {
        calloutTypes: {
          mytype: { label: 'My type', color: '#ff8800', icon: 'star' },
          gone: null,
          fromNewerBuild: { shape: 'unknown' }
        }
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
      tasks: { defaultProjectId: null }
    })
    expect(result.success).toBe(true)
  })

  it('accepts a calendar group with weekStartDay', () => {
    const result = SyncedSettingsSchema.safeParse({
      calendar: { weekStartDay: 'sunday' }
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid tasks.defaultSortOrder', () => {
    const result = SyncedSettingsSchema.safeParse({
      tasks: { defaultSortOrder: 'alphabetical' }
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid calendar.weekStartDay', () => {
    const result = SyncedSettingsSchema.safeParse({
      calendar: { weekStartDay: 'friday' }
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

  it('keeps editor.convertChecklistsToTasks and parses an editor group from an older build without it', () => {
    expect(
      SyncedSettingsSchema.parse({ editor: { convertChecklistsToTasks: false } }).editor
    ).toEqual({ convertChecklistsToTasks: false })
    expect(SyncedSettingsSchema.parse({ editor: { width: 'full' } }).editor).toEqual({
      width: 'full'
    })
  })

  it('keeps editor.convertAgentChecklistsToTasks', () => {
    expect(
      SyncedSettingsSchema.parse({ editor: { convertAgentChecklistsToTasks: true } }).editor
    ).toEqual({ convertAgentChecklistsToTasks: true })
  })

  it('keeps editor.pdfDisplayMode and reads a payload without it', () => {
    expect(SyncedSettingsSchema.parse({ editor: { pdfDisplayMode: 'link' } }).editor).toEqual({
      pdfDisplayMode: 'link'
    })
    expect(SyncedSettingsSchema.parse({ editor: { width: 'full' } }).editor).toEqual({
      width: 'full'
    })
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
      tasks: { defaultSortOrder: 'manual' },
      calendar: { weekStartDay: 'monday' },
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
        editor: { width: 'wide' }
      },
      fieldClocks: {
        'general.theme': { 'device-a': 2 },
        'editor.width': { 'device-a': 1 }
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
