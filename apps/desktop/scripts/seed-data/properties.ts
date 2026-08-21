import type { SeedPropertyDefinition } from '../seed-vault/db-writer'

// ============================================================================
// Property definitions.
//
// `.memry/properties.md` is the source of truth — PropertyDefinitionsService
// reloads it on vault open and rebuilds the `property_definitions` table from
// it, so a DB-only seed would be wiped the first time the vault is opened.
// Only the five persistable kinds may appear in that file (status, select,
// multiselect, date, project); anything else fails PropertyDefinitionsFileSchema
// and discards *every* definition in the file. Text/number/url props are typed
// by inference from their values instead.
// ============================================================================

type SelectOption = { value: string; color: string; default?: boolean }

interface StatusCategory {
  label: string
  options: SelectOption[]
}

export type PersistableDefinition =
  | { name: string; type: 'status'; categories: Record<string, StatusCategory> }
  | { name: string; type: 'select'; options: SelectOption[] }
  | { name: string; type: 'multiselect'; options: SelectOption[] }
  | { name: string; type: 'date'; showOnCalendar?: boolean }
  | { name: string; type: 'project' }

/**
 * Workflow status shared by notes across every folder. Categories are what the
 * status editor groups by, so each bucket needs to read as a real stage.
 */
const STATUS_DEFINITION: PersistableDefinition = {
  name: 'status',
  type: 'status',
  categories: {
    todo: {
      label: 'To-do',
      options: [
        { value: 'idea', color: 'violet', default: true },
        { value: 'backlog', color: 'stone' },
        { value: 'planning', color: 'sky' }
      ]
    },
    in_progress: {
      label: 'In progress',
      options: [
        { value: 'active', color: 'amber' },
        { value: 'reading', color: 'tangerine' },
        { value: 'blocked', color: 'rose' }
      ]
    },
    done: {
      label: 'Complete',
      options: [
        { value: 'done', color: 'emerald' },
        { value: 'watched', color: 'mint' },
        { value: 'shipped', color: 'sage' },
        { value: 'reference', color: 'slate' },
        { value: 'abandoned', color: 'mauve' }
      ]
    }
  }
}

export const PERSISTABLE_PROPERTY_DEFINITIONS: PersistableDefinition[] = [
  STATUS_DEFINITION,

  // The reserved key that carries project membership. Its rows in
  // `project_links` are derived from note frontmatter by the note-project-links
  // projector, so this is how a seeded note joins a project and survives
  // re-indexing.
  { name: 'project', type: 'project' },

  {
    name: 'priority',
    type: 'select',
    options: [
      { value: 'high', color: 'rose' },
      { value: 'medium', color: 'amber', default: true },
      { value: 'low', color: 'stone' }
    ]
  },
  {
    name: 'area',
    type: 'select',
    options: [
      { value: 'Work', color: 'cobalt' },
      { value: 'Health', color: 'emerald' },
      { value: 'Travel', color: 'tangerine' },
      { value: 'Learning', color: 'violet' },
      { value: 'Home', color: 'sage' },
      { value: 'Money', color: 'lemon' }
    ]
  },
  {
    name: 'energy',
    type: 'select',
    options: [
      { value: 'deep', color: 'indigo' },
      { value: 'shallow', color: 'sand' },
      { value: 'admin', color: 'slate' }
    ]
  },
  {
    name: 'genre',
    type: 'select',
    options: [
      { value: 'sci-fi', color: 'indigo' },
      { value: 'drama', color: 'plum' },
      { value: 'thriller', color: 'rose' },
      { value: 'crime', color: 'coral' },
      { value: 'animation', color: 'mint' },
      { value: 'nonfiction', color: 'sky' },
      { value: 'memoir', color: 'sand' },
      { value: 'philosophy', color: 'mauve' },
      { value: 'mystery', color: 'teal' }
    ]
  },
  {
    name: 'format',
    type: 'multiselect',
    options: [
      { value: 'Hardcover', color: 'sand' },
      { value: 'Kindle', color: 'sky' },
      { value: 'Audiobook', color: 'plum' },
      { value: 'Cinema', color: 'rose' },
      { value: 'Streaming', color: 'cyan' }
    ]
  },
  {
    name: 'source',
    type: 'multiselect',
    options: [
      { value: 'Recommended', color: 'emerald' },
      { value: 'Bookclub', color: 'amber' },
      { value: 'Rewatch', color: 'violet' },
      { value: 'Backlog', color: 'stone' }
    ]
  },
  {
    name: 'level',
    type: 'select',
    options: [
      { value: 'beginner', color: 'sage' },
      { value: 'intermediate', color: 'amber' },
      { value: 'advanced', color: 'rose' }
    ]
  },
  {
    name: 'language',
    type: 'select',
    options: [
      { value: 'typescript', color: 'sky' },
      { value: 'javascript', color: 'amber' },
      { value: 'rust', color: 'coral' },
      { value: 'sql', color: 'violet' },
      { value: 'python', color: 'lemon' },
      { value: 'shell', color: 'slate' }
    ]
  },

  // Date props that surface on the calendar — the notes carrying them show up
  // as date chips on the month grid, which is a lot of the screenshot value.
  { name: 'deadline', type: 'date', showOnCalendar: true },
  { name: 'startDate', type: 'date', showOnCalendar: true },
  { name: 'endDate', type: 'date', showOnCalendar: true },
  { name: 'reviewOn', type: 'date', showOnCalendar: true }
]

/** The `properties:` frontmatter block written into `.memry/properties.md`. */
export function buildPropertiesFileData(): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const def of PERSISTABLE_PROPERTY_DEFINITIONS) {
    if (def.type === 'status') {
      properties[def.name] = { type: 'status', categories: def.categories }
    } else if (def.type === 'date') {
      properties[def.name] = { type: 'date', showOnCalendar: def.showOnCalendar ?? false }
    } else if (def.type === 'project') {
      properties[def.name] = { type: 'project' }
    } else {
      properties[def.name] = { type: def.type, options: def.options }
    }
  }
  return properties
}

/**
 * Warm the `property_definitions` cache table so the seeded vault reads right
 * even before the service's first reload. Mirrors rebuildSingleDbCache: a status
 * definition stores `{ categories }`, everything else stores its option list.
 * The inferred-only props (text/number/url) are seeded here as well so property
 * pickers have colors before any note is opened.
 */
export const PROPERTY_DEFINITION_ROWS: SeedPropertyDefinition[] = [
  ...PERSISTABLE_PROPERTY_DEFINITIONS.map((def) => ({
    name: def.name,
    type: def.type,
    options:
      def.type === 'status'
        ? JSON.stringify({ categories: def.categories })
        : def.type === 'select' || def.type === 'multiselect'
          ? JSON.stringify(def.options)
          : null,
    color: null
  })),
  { name: 'rating', type: 'number', color: '#C4A44E' },
  { name: 'pages', type: 'number', color: '#C4A44E' },
  { name: 'year', type: 'number', color: '#748CE0' },
  { name: 'mood', type: 'number', color: '#A470D0' },
  { name: 'weight', type: 'number', color: '#7CB86C' },
  { name: 'bodyFat', type: 'number', color: '#7CB86C' },
  { name: 'author', type: 'text', color: '#52AACC' },
  { name: 'director', type: 'text', color: '#D46C96' },
  { name: 'location', type: 'text', color: '#CC9456' },
  { name: 'owner', type: 'text', color: '#949490' },
  { name: 'url', type: 'url', color: '#64A0D8' },
  { name: 'shared', type: 'checkbox', color: '#50B888' }
]
