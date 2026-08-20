import { z } from 'zod'
import { VectorClockSchema } from './sync-api'

export const SyncedSettingsSchema = z.object({
  general: z
    .object({
      theme: z.enum(['light', 'dark', 'white', 'system']).optional(),
      fontSize: z.enum(['small', 'medium', 'large']).optional(),
      fontFamily: z
        .enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter'])
        .optional(),
      accentColor: z.string().optional(),
      startOnBoot: z.boolean().optional(),
      language: z.string().optional(),
      createInSelectedFolder: z.boolean().optional()
    })
    .optional(),
  editor: z
    .object({
      // Accept legacy widths from older devices; new devices only emit normal/full.
      width: z.enum(['normal', 'full', 'narrow', 'medium', 'wide']).optional(),
      toolbarMode: z.enum(['floating', 'sticky']).optional()
    })
    .optional(),
  tasks: z
    .object({
      defaultProjectId: z.string().nullable().optional(),
      defaultSortOrder: z.enum(['manual', 'dueDate', 'priority', 'createdAt']).optional(),
      staleInboxDays: z.number().optional(),
      showCompleted: z.boolean().optional(),
      sortBy: z.string().optional()
    })
    .optional(),
  calendar: z
    .object({
      weekStartDay: z.enum(['sunday', 'monday']).optional()
    })
    .optional(),
  keyboard: z
    .object({
      overrides: z.record(z.string(), z.unknown()).optional()
    })
    .optional(),
  notes: z
    .object({
      defaultFolder: z.string().optional(),
      editorFontSize: z.number().optional(),
      spellCheck: z.boolean().optional()
    })
    .optional(),
  sync: z
    .object({
      autoSync: z.boolean().optional(),
      syncIntervalMinutes: z.number().optional()
    })
    .optional(),
  inbox: z
    .object({
      reviewReminderEnabled: z.boolean().optional(),
      reviewReminderTime: z.string().optional()
    })
    .optional(),
  journal: z
    .object({
      defaultTemplate: z.string().nullable().optional(),
      // Keyed by JS getDay() ("0" = Sunday … "6" = Saturday), stored as strings
      // because JSON object keys are strings and each day carries its own field
      // clock (`journal.weekdayTemplates.<day>`) so two devices editing
      // different days concurrently both keep their edit.
      //
      // The key stays an unconstrained string on purpose: a single malformed
      // key from a future or corrupted writer must not fail the whole settings
      // payload and stall every other synced setting. Readers ignore anything
      // outside "0".."6".
      weekdayTemplates: z.record(z.string(), z.string().nullable()).optional()
    })
    .optional()
})

export const FieldClockMapSchema = z.record(z.string(), VectorClockSchema)

export const SettingsSyncPayloadSchema = z.object({
  settings: SyncedSettingsSchema,
  fieldClocks: FieldClockMapSchema
})

export type SyncedSettings = z.infer<typeof SyncedSettingsSchema>
export type FieldClockMap = z.infer<typeof FieldClockMapSchema>
export type SettingsSyncPayload = z.infer<typeof SettingsSyncPayloadSchema>
