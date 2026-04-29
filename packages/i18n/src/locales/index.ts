/**
 * Re-export all locale JSON resources for direct access. Most consumers
 * use the i18next instance via /main or /renderer instead.
 */

import enCommon from './en/common.json'
import enInbox from './en/inbox.json'
import enNotes from './en/notes.json'
import enJournal from './en/journal.json'
import enCalendar from './en/calendar.json'
import enTasks from './en/tasks.json'
import enSettings from './en/settings.json'
import enErrors from './en/errors.json'
import enMenu from './en/menu.json'

import trCommon from './tr/common.json'
import trInbox from './tr/inbox.json'
import trNotes from './tr/notes.json'
import trJournal from './tr/journal.json'
import trCalendar from './tr/calendar.json'
import trTasks from './tr/tasks.json'
import trSettings from './tr/settings.json'
import trErrors from './tr/errors.json'
import trMenu from './tr/menu.json'

import arCommon from './ar/common.json'
import arInbox from './ar/inbox.json'
import arNotes from './ar/notes.json'
import arJournal from './ar/journal.json'
import arCalendar from './ar/calendar.json'
import arTasks from './ar/tasks.json'
import arSettings from './ar/settings.json'
import arErrors from './ar/errors.json'
import arMenu from './ar/menu.json'

export const RESOURCES = {
  en: {
    common: enCommon,
    inbox: enInbox,
    notes: enNotes,
    journal: enJournal,
    calendar: enCalendar,
    tasks: enTasks,
    settings: enSettings,
    errors: enErrors,
    menu: enMenu
  },
  tr: {
    common: trCommon,
    inbox: trInbox,
    notes: trNotes,
    journal: trJournal,
    calendar: trCalendar,
    tasks: trTasks,
    settings: trSettings,
    errors: trErrors,
    menu: trMenu
  },
  ar: {
    common: arCommon,
    inbox: arInbox,
    notes: arNotes,
    journal: arJournal,
    calendar: arCalendar,
    tasks: arTasks,
    settings: arSettings,
    errors: arErrors,
    menu: arMenu
  }
} as const
