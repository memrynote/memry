// Vault-level organization: tag colors and categories, templates, folder
// views and icons, saved task filters, and the Home board layout.
import type { TemplateProperty } from '@memry/contracts/templates-api'

import { tagSpecs } from './tag-schemas.ts'

export const tagCategories: Array<{ id: string; name: string; tags: Record<string, string> }> = [
  {
    id: 'tagcat_work',
    name: 'Work',
    tags: {
      aurora: 'amber',
      'aurora/beta': 'tangerine',
      design: 'violet',
      decision: 'indigo',
      studio: 'slate'
    }
  },
  {
    id: 'tagcat_research',
    name: 'Research',
    tags: {
      'space-race': 'cobalt',
      apollo: 'teal',
      concept: 'cyan',
      source: 'stone',
      paper: 'mauve',
      essay: 'rose'
    }
  },
  {
    id: 'tagcat_fields',
    name: 'Tags with fields',
    tags: Object.fromEntries(tagSpecs.map((spec) => [spec.key, spec.color]))
  },
  {
    id: 'tagcat_life',
    name: 'Life',
    tags: {
      vegetarian: 'sage',
      baking: 'sand',
      travel: 'emerald',
      hiking: 'mint',
      cooking: 'lemon'
    }
  }
]

/** Colored but left uncategorized, so the sidebar shows both cases. */
export const looseTagColors: Record<string, string> = {
  guide: 'magenta',
  'notes-101': 'cobalt',
  reading: 'plum',
  idea: 'lemon',
  writing: 'rose'
}

export const templateSpecs: Array<{
  key: string
  name: string
  description: string
  icon: string
  tags: string[]
  properties: TemplateProperty[]
  content: string
}> = [
  {
    key: 'paper',
    name: 'Paper note',
    description: 'Summary, takeaways and open questions for a paper',
    icon: '📄',
    tags: ['paper'],
    properties: [
      { name: 'source', type: 'url', value: '' },
      {
        name: 'topics',
        type: 'multiselect',
        value: [],
        options: ['Spaceflight', 'History', 'Note-taking', 'Design', 'Writing']
      }
    ],
    content: '## Summary\n\n## Takeaways\n\n## Questions\n'
  },
  {
    key: 'journal',
    name: 'Daily journal',
    description: 'Plan, notes and a line for the evening',
    icon: '📓',
    tags: [],
    properties: [
      { name: 'mood', type: 'number', value: 6 },
      { name: 'sleep', type: 'number', value: 7 },
      { name: 'workout', type: 'checkbox', value: false }
    ],
    content: '## Plan\n\n## Notes\n\n## Evening\n'
  }
]

export const folderIcons: Record<string, string> = {
  'Start here': '🧭',
  'Notes 101': '📘',
  Work: '💼',
  'Work/Aurora': '🌅',
  'Work/Aurora/Meetings': '🗣️',
  'Work/Clients': '🤝',
  People: '👥',
  Companies: '🏢',
  Research: '🔭',
  'Research/Reading list': '📚',
  'Research/Papers': '📄',
  Kitchen: '🍳',
  'Kitchen/Recipes': '🥘',
  Travel: '🧳',
  Writing: '✍️'
}

/** Folder defaults. Notes that carry a tag with fields get that tag's template instead. */
export const folderTemplates: Record<string, string> = {
  'Research/Papers': 'paper'
}

const filterBase = {
  search: '',
  projectIds: [] as string[],
  priorities: [] as string[],
  tags: [] as string[],
  dueDate: { type: 'any' },
  statusIds: [] as string[],
  completion: 'active',
  repeatType: 'all',
  hasTime: 'all'
}

/** `projectKey` is replaced by the project id when the filter is saved. */
export const savedFilterSpecs = [
  {
    name: 'Overdue and important',
    projectKey: null,
    filters: { ...filterBase, priorities: ['urgent', 'high'], dueDate: { type: 'overdue' } },
    sort: { field: 'dueDate', direction: 'asc' },
    starred: true
  },
  {
    name: 'Aurora this week',
    projectKey: 'aurora',
    filters: { ...filterBase, dueDate: { type: 'this-week' } },
    sort: { field: 'priority', direction: 'desc' },
    starred: false
  },
  {
    name: 'Trip prep',
    projectKey: null,
    filters: { ...filterBase, tags: ['travel'] },
    sort: { field: 'dueDate', direction: 'asc' },
    starred: false
  }
] as const

/** Home board on an 8-column grid. Config ids are filled in by post/organize.ts. */
export const homeWidgets = [
  { id: 'w-tasks', type: 'tasks', x: 0, y: 0, w: 4, h: 5, config: { dateRange: 'today' } },
  { id: 'w-calendar', type: 'calendar', x: 4, y: 0, w: 4, h: 5, config: {} },
  { id: 'w-journal', type: 'journal', x: 0, y: 5, w: 4, h: 4, config: {} },
  { id: 'w-inbox', type: 'inbox', x: 4, y: 5, w: 4, h: 4, config: {} },
  { id: 'w-project', type: 'project', x: 0, y: 9, w: 4, h: 5, config: { projectId: 'aurora' } },
  {
    id: 'w-mood',
    type: 'chart',
    x: 4,
    y: 9,
    w: 4,
    h: 5,
    config: {
      source: { kind: 'journal' },
      chart: { property: 'mood', type: 'line', rangeDays: 30, aggregate: 'average', missing: 'gap' }
    }
  },
  { id: 'w-recent', type: 'recently-edited', x: 0, y: 14, w: 4, h: 4, config: {} },
  { id: 'w-bookmarks', type: 'bookmarks', x: 4, y: 14, w: 4, h: 4, config: {} },
  {
    id: 'w-reading',
    type: 'folder',
    x: 0,
    y: 18,
    w: 4,
    h: 4,
    config: { folderPath: 'Research/Reading list' }
  },
  { id: 'w-opened', type: 'recently-opened', x: 4, y: 18, w: 4, h: 4, config: {} }
]
