import type { CommandMeta } from './types'

/**
 * Commands that open a page as a tab. `go.*` is the sidebar's own click: the
 * page, as it opens from the rail. `create.*` lands the user ready to add, with
 * the intent `newItemViewState` carries for the New menu. A page with no such
 * intent (Journal opens on today's entry) has no `create.*` command.
 */
export const PAGE_COMMANDS = {
  'go.home': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goHome'
  },
  'go.inbox': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goInbox'
  },
  'go.journal': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goJournal'
  },
  'go.calendar': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goCalendar'
  },
  'go.tasks': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goTasks'
  },
  'go.graph': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goGraph'
  },
  'go.tags': {
    context: 'app',
    owner: 'pages',
    group: 'navigation',
    i18nKey: 'commands.goTags'
  },
  'create.task': {
    context: 'app',
    owner: 'pages',
    group: 'create',
    i18nKey: 'commands.createTask'
  },
  'create.calendarEvent': {
    context: 'app',
    owner: 'pages',
    group: 'create',
    i18nKey: 'commands.createCalendarEvent'
  },
  'create.inboxItem': {
    context: 'app',
    owner: 'pages',
    group: 'create',
    i18nKey: 'commands.createInboxItem'
  }
} as const satisfies Record<string, CommandMeta>
