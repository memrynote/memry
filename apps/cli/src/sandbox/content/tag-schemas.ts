// Tags with fields, as data. The four ready-made tags mirror what "Add" in the
// Tags hub stores (apps/desktop/src/main/tags/preset-catalog.ts, English
// strings from packages/i18n/src/locales/en/notes.json `tagFields.presets`).
// The rest are custom tags a user would build by hand. Tag keys are lowercase,
// the way the app stores `tag_definitions.name`.
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import type { PresetKey } from '@memry/contracts/tag-schema'

export type FieldType = 'text' | 'number' | 'url' | 'date' | 'select' | 'relation'

export interface FieldSpec {
  name: string
  type: FieldType
  options?: Array<[value: string, color: string]>
  showOnCalendar?: boolean
  /** A relation field: lowercase target tag, cardinality, and the label of the inverse list. */
  relation?: { target: string; many: boolean; inverse: string }
}

export interface TagSpec {
  key: string
  color: string
  icon: string
  preset?: PresetKey
  extends?: string
  fields: FieldSpec[]
  /** Autofilled when a note gets the tag: the template's name and its `##` sections. */
  template?: { name: string; sections: Array<{ heading: string; hint?: string }> }
  views: ViewConfig[]
}

const table = (
  name: string,
  columns: string[],
  rest: Partial<ViewConfig> = {},
  isDefault = false
): ViewConfig => ({
  name,
  type: 'table',
  ...(isDefault ? { default: true } : {}),
  columns: columns.map((id) => ({ id })),
  ...rest
})

/** In the order a user clicks "Add": Person brings Company with it, then Meeting, then Book. */
export const tagSpecs: TagSpec[] = [
  {
    key: 'company',
    color: 'indigo',
    icon: 'icon:Building03Icon',
    preset: 'company',
    fields: [
      { name: 'Website', type: 'url' },
      { name: 'Industry', type: 'text' },
      { name: 'Location', type: 'text' }
    ],
    template: {
      name: 'Company',
      sections: [
        { heading: 'Overview', hint: 'What they do, who we know there' },
        { heading: 'Notes' }
      ]
    },
    views: [table('Companies', ['title', 'Website', 'Industry', 'Location'], {}, true)]
  },
  {
    key: 'person',
    color: 'sky',
    icon: 'icon:UserIcon',
    preset: 'person',
    fields: [
      {
        name: 'Company',
        type: 'relation',
        relation: { target: 'company', many: false, inverse: 'People' }
      },
      { name: 'Role', type: 'text' },
      { name: 'Email', type: 'text' },
      { name: 'Phone', type: 'text' }
    ],
    template: {
      name: 'Person',
      sections: [
        { heading: 'Context', hint: 'How we met, what they care about' },
        { heading: 'Notes' }
      ]
    },
    views: [
      table('People', ['title', 'Company', 'Role', 'Email', 'Phone'], {}, true),
      table('By company', ['title', 'Role', 'Email'], { groupBy: { property: 'Company' } })
    ]
  },
  {
    key: 'meeting',
    color: 'amber',
    icon: 'icon:Calendar03Icon',
    preset: 'meeting',
    fields: [
      { name: 'Date', type: 'date', showOnCalendar: true },
      {
        name: 'Attendees',
        type: 'relation',
        relation: { target: 'person', many: true, inverse: 'Meetings' }
      },
      {
        name: 'Company',
        type: 'relation',
        relation: { target: 'company', many: false, inverse: 'Meetings' }
      }
    ],
    template: {
      name: 'Meeting',
      sections: [{ heading: 'Agenda' }, { heading: 'Notes' }, { heading: 'Action items' }]
    },
    views: [
      table(
        'Meetings',
        ['title', 'Date', 'Attendees', 'Company'],
        { order: [{ property: 'Date', direction: 'desc' }] },
        true
      ),
      table('By company', ['title', 'Date', 'Attendees'], { groupBy: { property: 'Company' } })
    ]
  },
  {
    key: 'book',
    color: 'emerald',
    icon: 'icon:BookOpen01Icon',
    preset: 'book',
    fields: [
      { name: 'Author', type: 'text' },
      {
        name: 'Shelf',
        type: 'select',
        options: [
          ['To read', 'stone'],
          ['Reading', 'amber'],
          ['Read', 'green']
        ]
      },
      { name: 'Rating', type: 'number' },
      { name: 'Finished', type: 'date' }
    ],
    template: {
      name: 'Book',
      sections: [{ heading: 'Highlights' }, { heading: 'Thoughts' }]
    },
    views: [
      table(
        'By shelf',
        ['title', 'Author', 'Rating', 'Finished'],
        { groupBy: { property: 'Shelf' }, order: [{ property: 'Rating', direction: 'desc' }] },
        true
      )
    ]
  },

  // Custom tags.
  {
    key: 'recipe',
    color: 'coral',
    icon: 'icon:Leaf01Icon',
    fields: [
      {
        name: 'Course',
        type: 'select',
        options: [
          ['Breakfast', 'lemon'],
          ['Main', 'coral'],
          ['Side', 'sage'],
          ['Dessert', 'plum']
        ]
      },
      { name: 'Time', type: 'number' },
      { name: 'Servings', type: 'number' },
      // Rating and source are already properties (a Book field, and the space race sources):
      // a field named like one reuses it, and the stored name takes that property's casing.
      { name: 'Rating', type: 'number' },
      { name: 'source', type: 'url' }
    ],
    template: {
      name: 'Recipe',
      sections: [{ heading: 'Ingredients' }, { heading: 'Method' }, { heading: 'Notes' }]
    },
    views: [
      table(
        'By course',
        ['title', 'Time', 'Servings', 'Rating'],
        { groupBy: { property: 'Course' } },
        true
      ),
      { name: 'Gallery', type: 'grid', columns: ['title', 'Course', 'Time'].map((id) => ({ id })) }
    ]
  },
  {
    key: 'client',
    color: 'violet',
    icon: 'icon:UserCheck01Icon',
    extends: 'company',
    fields: [
      {
        name: 'Contract',
        type: 'select',
        options: [
          ['Retainer', 'sky'],
          ['Fixed price', 'amber'],
          ['Pilot', 'violet']
        ]
      }
    ],
    views: [table('Clients', ['title', 'Contract', 'Website', 'Industry', 'Location'], {}, true)]
  },
  {
    key: 'waiting',
    color: 'orange',
    icon: 'icon:Clock01Icon',
    // A task field: it appears in the task drawer, and the person's note lists the task.
    fields: [
      {
        name: 'Waiting on',
        type: 'relation',
        relation: { target: 'person', many: false, inverse: 'Waiting tasks' }
      }
    ],
    views: []
  }
]
