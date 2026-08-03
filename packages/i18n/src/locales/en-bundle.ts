/**
 * The English resources, statically imported.
 *
 * Everything else loads locale JSON lazily through the i18next backend. This
 * bundle exists for the one case that cannot await anything: the main process
 * needs a synchronous, always-available English instance to fall back on when a
 * translation is requested before boot has installed the real one.
 */

import common from './en/common.json'
import inbox from './en/inbox.json'
import notes from './en/notes.json'
import journal from './en/journal.json'
import calendar from './en/calendar.json'
import tasks from './en/tasks.json'
import graph from './en/graph.json'
import settings from './en/settings.json'
import errors from './en/errors.json'
import menu from './en/menu.json'
import system from './en/system.json'

export const EN_BUNDLE = {
  common,
  inbox,
  notes,
  journal,
  calendar,
  tasks,
  graph,
  settings,
  errors,
  menu,
  system
}
