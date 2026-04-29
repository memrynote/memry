/**
 * TypeScript module augmentation that types `t()` calls against the
 * English locale resources (the source of truth). Bad keys become
 * compile-time errors.
 *
 * Usage:
 *   const { t } = useT('inbox')
 *   t('triage.archive')         // ✅ checked against en/inbox.json
 *   t('triage.does-not-exist')  // ❌ TS error
 */

import 'i18next'

import type common from '../locales/en/common.json'
import type inbox from '../locales/en/inbox.json'
import type notes from '../locales/en/notes.json'
import type journal from '../locales/en/journal.json'
import type calendar from '../locales/en/calendar.json'
import type tasks from '../locales/en/tasks.json'
import type settings from '../locales/en/settings.json'
import type errors from '../locales/en/errors.json'
import type menu from '../locales/en/menu.json'

export interface Resources {
  common: typeof common
  inbox: typeof inbox
  notes: typeof notes
  journal: typeof journal
  calendar: typeof calendar
  tasks: typeof tasks
  settings: typeof settings
  errors: typeof errors
  menu: typeof menu
}

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: Resources
  }
}
