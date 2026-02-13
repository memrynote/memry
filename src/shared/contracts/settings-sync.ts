import { z } from 'zod'
import { VectorClockSchema } from './sync-api'

export const SyncedSettingsSchema = z.object({
  general: z
    .object({
      theme: z.enum(['light', 'dark', 'system']).optional(),
      language: z.string().optional(),
      startOnBoot: z.boolean().optional()
    })
    .optional(),
  tasks: z
    .object({
      defaultProjectId: z.string().optional(),
      showCompleted: z.boolean().optional(),
      sortBy: z.string().optional()
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
