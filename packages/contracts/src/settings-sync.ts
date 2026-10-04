import { z } from 'zod'
import { VectorClockSchema } from './sync-api'
import { SidebarSortModesSchema } from './sidebar-sort'

/** A non-Google provider's synced settings (`calendar.<provider>`, spec 007 D3a). */
const CalendarProviderSyncedSettingsSchema = z.object({
  agentReadEventsConsent: z.boolean().nullable().optional(),
  pushEventsToProvider: z.boolean().optional()
})

export const SyncedSettingsSchema = z.object({
  general: z
    .object({
      theme: z.enum(['light', 'dark', 'white', 'system']).optional(),
      fontSize: z.enum(['small', 'medium', 'large']).optional(),
      // Unconstrained number, not the bounded integer the UI enforces: a value
      // written by another device must ride along rather than fail the whole
      // settings payload and stall every other synced setting.
      fontSizePx: z.number().optional(),
      fontFamily: z
        .enum(['system', 'serif', 'sans-serif', 'monospace', 'gelasio', 'geist', 'inter'])
        .optional(),
      // Loose string, not the sanitized shape the UI enforces: a name written
      // by another device must ride along rather than fail the whole settings
      // payload and stall every other synced setting.
      customFontFamily: z.string().optional(),
      accentColor: z.string().optional(),
      // Loose string for the same reason: a theme id only a newer build knows
      // must ride along, and the renderer falls back to the built-in palette.
      colorTheme: z.string().optional(),
      useThemeAccent: z.boolean().optional(),
      backgroundLight: z.string().optional(),
      foregroundLight: z.string().optional(),
      backgroundDark: z.string().optional(),
      foregroundDark: z.string().optional(),
      startOnBoot: z.boolean().optional(),
      language: z.string().optional(),
      createInSelectedFolder: z.boolean().optional(),
      openPagesInNewTab: z.boolean().optional(),
      minimizeToTray: z.boolean().optional()
    })
    .optional(),
  editor: z
    .object({
      // Accept legacy widths from older devices; new devices only emit normal/full.
      width: z.enum(['normal', 'full', 'narrow', 'medium', 'wide']).optional(),
      toolbarMode: z.enum(['floating', 'sticky']).optional(),
      pdfAdaptToTheme: z.boolean().optional(),
      // Absent in every payload a build older than this toggle writes, and
      // that build's schema drops it on parse instead of rejecting the payload.
      convertChecklistsToTasks: z.boolean().optional()
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
  // Spec 007 D3a: calendar settings follow the user across devices, one field
  // clock per leaf (`calendar.google.pushEventsToGoogle`, ...). Every key is
  // optional, and `catchall` lets a provider group a newer build adds ride
  // along instead of being stripped.
  calendar: z
    .object({
      weekStartDay: z.enum(['sunday', 'monday']).optional(),
      showNotesOnCalendar: z.boolean().optional(),
      // `null` = no cross-provider default (routing falls back to Google's).
      defaultWriteTarget: z
        .object({ provider: z.string(), remoteCalendarId: z.string() })
        .nullable()
        .optional(),
      google: z
        .object({
          defaultTargetCalendarId: z.string().nullable().optional(),
          onboardingCompleted: z.boolean().optional(),
          promoteConfirmDismissed: z.boolean().optional(),
          pushEventsToGoogle: z.boolean().optional(),
          agentReadEventsConsent: z.boolean().nullable().optional()
        })
        .optional(),
      caldav: CalendarProviderSyncedSettingsSchema.optional(),
      ics: CalendarProviderSyncedSettingsSchema.optional()
    })
    .catchall(z.unknown())
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
    .optional(),
  // Same per-key clocking as journal.weekdayTemplates above: field clocks are
  // keyed by dotted path at arbitrary depth, so each surface
  // ('sidebar.sortModes.collections', ...) carries its own clock and two
  // devices changing two different sections both keep their change.
  sidebar: z
    .object({
      sortModes: SidebarSortModesSchema.optional(),
      // One list, one clock: reordering is a whole-list operation, so the last
      // device to drag wins rather than two partial orders interleaving. Ids
      // stay unconstrained strings — a section a newer build added must ride
      // along instead of failing the whole settings payload.
      sectionOrder: z.array(z.string()).optional(),
      // The app rail's page icons (home, inbox, ...), same one-list-one-clock
      // rule as sectionOrder. Absent means the default order; older builds
      // strip it on parse.
      railOrder: z.array(z.string()).optional(),
      // One flag under one clock: collapsing hides the whole nav block at
      // once, so there is no per-row state for two devices to interleave.
      // Absent means expanded, which is every payload a build older than this
      // toggle writes.
      navCollapsed: z.boolean().optional(),
      // Collections tree view options, one flag and one clock each, same shape
      // as navCollapsed. Absent means today's tree: folders before notes, and
      // files shown. A build older than these toggles writes neither field,
      // and its schema drops both on parse instead of rejecting the payload.
      notesFirst: z.boolean().optional(),
      showFiles: z.boolean().optional()
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
