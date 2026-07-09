/**
 * Editable theme variable registry — the single source for which CSS custom
 * properties the custom-theme editor exposes, grouped Core / Advanced.
 * A drift test asserts every entry exists in base.css.
 *
 * @module lib/theme-variables
 */

export interface ThemeVariableDef {
  cssVar: string
  group: 'core' | 'advanced'
  /** Section key — also used as the i18n-able section heading id. */
  section: string
  /** Optional explicit label; otherwise derived from the variable name. */
  label?: string
}

export const THEME_VARIABLES: ThemeVariableDef[] = [
  // Core — surfaces
  { cssVar: '--background', group: 'core', section: 'surfaces' },
  { cssVar: '--foreground', group: 'core', section: 'surfaces' },
  { cssVar: '--surface', group: 'core', section: 'surfaces' },
  { cssVar: '--surface-active', group: 'core', section: 'surfaces', label: 'Hover' },
  { cssVar: '--border', group: 'core', section: 'surfaces' },
  { cssVar: '--input', group: 'core', section: 'surfaces' },
  { cssVar: '--popover', group: 'core', section: 'surfaces' },
  { cssVar: '--popover-foreground', group: 'core', section: 'surfaces' },
  { cssVar: '--card', group: 'core', section: 'surfaces' },
  { cssVar: '--card-foreground', group: 'core', section: 'surfaces' },

  // Core — text
  { cssVar: '--text-primary', group: 'core', section: 'text' },
  { cssVar: '--text-secondary', group: 'core', section: 'text' },
  { cssVar: '--text-tertiary', group: 'core', section: 'text' },
  { cssVar: '--text-bright', group: 'core', section: 'text' },
  { cssVar: '--muted', group: 'core', section: 'text' },
  { cssVar: '--muted-foreground', group: 'core', section: 'text' },

  // Core — sidebar
  { cssVar: '--sidebar', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-foreground', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-surface', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-accent', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-border', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-muted', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-text-folder', group: 'core', section: 'sidebar' },
  { cssVar: '--sidebar-text-child', group: 'core', section: 'sidebar' },

  // Core — accent
  { cssVar: '--user-accent-color', group: 'core', section: 'accent', label: 'Accent' },

  // Advanced — category dots
  { cssVar: '--accent', group: 'advanced', section: 'dots' },
  { cssVar: '--accent-foreground', group: 'advanced', section: 'dots' },
  { cssVar: '--accent-cyan', group: 'advanced', section: 'dots' },
  { cssVar: '--accent-purple', group: 'advanced', section: 'dots' },
  { cssVar: '--accent-green', group: 'advanced', section: 'dots' },
  { cssVar: '--accent-orange', group: 'advanced', section: 'dots' },

  // Advanced — semantic cards
  { cssVar: '--card-sage', group: 'advanced', section: 'cards' },
  { cssVar: '--card-rose', group: 'advanced', section: 'cards' },
  { cssVar: '--card-sand', group: 'advanced', section: 'cards' },
  { cssVar: '--card-lavender', group: 'advanced', section: 'cards' },
  { cssVar: '--card-grey', group: 'advanced', section: 'cards' },

  // Advanced — states
  { cssVar: '--primary', group: 'advanced', section: 'states' },
  { cssVar: '--primary-foreground', group: 'advanced', section: 'states' },
  { cssVar: '--secondary', group: 'advanced', section: 'states' },
  { cssVar: '--secondary-foreground', group: 'advanced', section: 'states' },
  { cssVar: '--destructive', group: 'advanced', section: 'states' },
  { cssVar: '--destructive-foreground', group: 'advanced', section: 'states' },
  { cssVar: '--ring', group: 'advanced', section: 'states' },

  // Advanced — sidebar details
  { cssVar: '--sidebar-primary', group: 'advanced', section: 'sidebarDetails' },
  { cssVar: '--sidebar-primary-foreground', group: 'advanced', section: 'sidebarDetails' },
  { cssVar: '--sidebar-accent-foreground', group: 'advanced', section: 'sidebarDetails' },
  { cssVar: '--sidebar-dot-inactive', group: 'advanced', section: 'sidebarDetails' },

  // Advanced — graph
  { cssVar: '--graph-bg', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-node-note', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-node-journal', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-node-task', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-node-project', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-node-tag', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-edge-default', group: 'advanced', section: 'graph' },
  { cssVar: '--graph-label-color', group: 'advanced', section: 'graph' },

  // Advanced — tasks
  { cssVar: '--task-priority-urgent', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-priority-high', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-priority-medium', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-priority-low', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-priority-none', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-due-overdue', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-due-today', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-due-tomorrow', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-due-upcoming', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-complete', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-checkbox-done', group: 'advanced', section: 'tasks' },
  { cssVar: '--task-star', group: 'advanced', section: 'tasks' },

  // Advanced — queue
  { cssVar: '--queue-bg', group: 'advanced', section: 'queue' },
  { cssVar: '--queue-number-bg', group: 'advanced', section: 'queue' }
]

export function labelForThemeVariable(def: ThemeVariableDef): string {
  if (def.label) return def.label
  return def.cssVar
    .replace(/^--/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}
