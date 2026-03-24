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
      language: z.string().optional()
    })
    .optional(),
  editor: z
    .object({
      width: z.enum(['narrow', 'medium', 'wide']).optional(),
      spellCheck: z.boolean().optional(),
      autoSaveDelay: z.number().optional(),
      showWordCount: z.boolean().optional(),
      toolbarMode: z.enum(['floating', 'sticky']).optional()
    })
    .optional(),
  tasks: z
    .object({
      defaultProjectId: z.string().nullable().optional(),
      defaultSortOrder: z.enum(['manual', 'dueDate', 'priority', 'createdAt']).optional(),
      weekStartDay: z.enum(['sunday', 'monday']).optional(),
      staleInboxDays: z.number().optional(),
      showCompleted: z.boolean().optional(),
      sortBy: z.string().optional()
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
