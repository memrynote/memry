import { EN_BUNDLE } from '@memry/i18n/locales/en-bundle'
import type { ViewConfig } from '@memry/contracts/folder-view-api'
import type { PresetKey, TagFieldStored } from '@memry/contracts/tag-schema'
import {
  stampVersionedMapPatch,
  stampVersionedValue,
  type VersionedObject
} from '@memry/shared/versioned'
import { generateId, generateNoteId } from '../../src/main/lib/id'
import { PRESET_CATALOG, presetSpec, type PresetSpec } from '../../src/main/tags/preset-catalog'
import { canonicalFieldName, serializeSchema } from '../../src/main/tags/tag-schema'
import type {
  SeedNoteMetadata,
  SeedTagDefinition,
  SeedTask,
  SeedTaskTag,
  SeedTemplate
} from '../seed-vault/db-writer'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedDateOnly, seedPastISOAt } from './date'
import { PERSISTABLE_PROPERTY_DEFINITIONS, PROPERTY_DEFINITION_ROWS } from './properties'
import { PROJECT_IDS, STATUS_IDS } from './tasks'

// Tags with fields: the four ready-made tags (person, company, meeting, book),
// #employee extends #person, #delegated for tasks, and the notes and tasks
// that use them. Schemas come from the production preset catalog and are
// stamped with the production versioned helpers, never hand-written JSON.
// The plain `people` / `meetings` tags stay as they are: the hub shows the
// label-vs-tag-with-fields difference.

/** `notes:tagFields.presets.person.name` → the English string, as `addPreset` would in English. */
function en(key: string): string {
  const [ns, path] = key.split(':') as [keyof typeof EN_BUNDLE, string]
  let node: unknown = EN_BUNDLE[ns]
  for (const part of path.split('.')) node = (node as Record<string, unknown>)[part]
  if (typeof node !== 'string') throw new Error(`seed objects: no English string for ${key}`)
  return node
}

const KNOWN_FIELD_NAMES = [
  ...PERSISTABLE_PROPERTY_DEFINITIONS.map((def) => def.name),
  ...PROPERTY_DEFINITION_ROWS.map((row) => row.name)
]
const fieldName = (typed: string): string => canonicalFieldName(typed, KNOWN_FIELD_NAMES).name

const tagName = (spec: PresetSpec): string => en(spec.nameKey).toLowerCase()

const MODIFIED = seedPastISOAt(-1, 17, 0)
const uri = (id: string): string => `memry://note/${id}`

const TEMPLATE_IDS = Object.fromEntries(
  PRESET_CATALOG.map((spec) => [spec.key, generateNoteId()])
) as Record<PresetKey, string>

export const OBJECT_TEMPLATES: SeedTemplate[] = PRESET_CATALOG.map((spec) => ({
  id: TEMPLATE_IDS[spec.key],
  name: en(spec.template.nameKey),
  content: spec.template.sections
    .map((s) => [`## ${en(s.headingKey)}`, ...(s.hintKey ? [en(s.hintKey)] : [])].join('\n'))
    .join('\n\n')
    .concat('\n')
}))

function presetFields(spec: PresetSpec): TagFieldStored[] {
  return spec.fields.map((field) =>
    field.relation
      ? {
          name: fieldName(en(field.nameKey)),
          relation: {
            target: tagName(presetSpec(field.relation.target)),
            many: field.relation.many,
            inverse: en(field.relation.inverseKey)
          }
        }
      : { name: fieldName(en(field.nameKey)) }
  )
}

function schemaColumn(body: {
  fields: TagFieldStored[]
  template: { id: string; autofill: boolean } | null
  extends: string | null
  preset: PresetKey | null
}): string {
  return serializeSchema(stampVersionedValue(undefined, { ...body, t: 0 } as VersionedObject))
}

/** Same columns as the app's default view for a tag with fields (`defaultFieldTagView`). */
function viewsFor(spec: PresetSpec, groupedName: string): string {
  const columns = [
    { id: 'title', width: 250 },
    ...presetFields(spec).map((field) => ({ id: field.name, width: 150 })),
    { id: 'modified', width: 130 }
  ]
  const list: ViewConfig[] = [
    { name: `All ${groupedName}`, type: 'table', default: true, columns },
    { name: 'By company', type: 'table', columns, groupBy: { property: 'Company' } }
  ]
  return JSON.stringify(list)
}

const VIEWS: Partial<Record<PresetKey, string>> = {
  person: viewsFor(presetSpec('person'), 'people'),
  meeting: viewsFor(presetSpec('meeting'), 'meetings')
}

export const OBJECT_TAG_DEFINITIONS: SeedTagDefinition[] = [
  ...PRESET_CATALOG.map((spec, index) => ({
    name: tagName(spec),
    color: spec.color,
    colorAuthored: true,
    icon: spec.icon,
    sortOrder: index,
    views: VIEWS[spec.key] ?? null,
    schema: schemaColumn({
      fields: presetFields(spec),
      template: { id: TEMPLATE_IDS[spec.key], autofill: true },
      extends: null,
      preset: spec.key
    })
  })),
  {
    name: 'employee',
    color: 'violet',
    colorAuthored: true,
    icon: 'icon:UserIcon',
    sortOrder: PRESET_CATALOG.length,
    schema: schemaColumn({
      fields: [
        { name: 'Team' },
        { name: 'Start date' },
        { name: 'Manager', relation: { target: 'person', many: false, inverse: 'Reports' } }
      ],
      template: null,
      extends: 'person',
      preset: null
    })
  },
  {
    name: 'delegated',
    color: 'rose',
    colorAuthored: true,
    sortOrder: PRESET_CATALOG.length + 1,
    schema: schemaColumn({
      fields: [
        { name: 'Waiting on', relation: { target: 'person', many: false, inverse: 'Waiting on' } },
        { name: 'Follow up' },
        { name: 'Thread' }
      ],
      template: null,
      extends: null,
      preset: null
    })
  }
]

interface ObjectNote {
  id: string
  path: string
  title: string
  daysAgo: number
  frontmatter: Record<string, unknown>
  body: string
}

const ID = {
  acme: generateNoteId(),
  globex: generateNoteId(),
  initech: generateNoteId(),
  ahmet: generateNoteId(),
  elif: generateNoteId(),
  mert: generateNoteId(),
  zeynep: generateNoteId(),
  deniz: generateNoteId(),
  can: generateNoteId(),
  cansu: generateNoteId()
} as const

export const OBJECT_NOTE_IDS = ID

const company = (
  id: string,
  title: string,
  props: Record<string, unknown>,
  body: string
): ObjectNote => ({
  id,
  path: `companies/${title}.md`,
  title,
  daysAgo: 30,
  frontmatter: { tags: ['company'], ...props },
  body
})

const person = (
  id: string,
  title: string,
  props: Record<string, unknown>,
  body: string,
  tag = 'person'
): ObjectNote => ({
  id,
  path: `people/${title}.md`,
  title,
  daysAgo: 20,
  frontmatter: { tags: [tag], ...props },
  body
})

const meeting = (
  title: string,
  daysFromToday: number,
  attendees: string[],
  companyId: string | null,
  body: string
): ObjectNote => ({
  id: generateNoteId(),
  path: `meetings/${title}.md`,
  title,
  daysAgo: Math.min(0, daysFromToday),
  frontmatter: {
    tags: ['meeting'],
    Date: seedDateOnly(daysFromToday),
    Attendees: attendees.map(uri),
    ...(companyId ? { Company: [uri(companyId)] } : {})
  },
  body
})

const book = (title: string, props: Record<string, unknown>, body: string): ObjectNote => ({
  id: generateNoteId(),
  path: `books/${title}.md`,
  title,
  daysAgo: 40,
  frontmatter: { tags: ['book'], ...props },
  body
})

const plain = (title: string, tags: string[], body: string): ObjectNote => ({
  id: generateNoteId(),
  path: `work/${title}.md`,
  title,
  daysAgo: 3,
  frontmatter: tags.length > 0 ? { tags } : {},
  body
})

const OBJECT_NOTES: ObjectNote[] = [
  company(
    ID.acme,
    'Acme',
    { Website: 'https://acme.example', Industry: 'Logistics', location: 'Istanbul' },
    '## Overview\nOur largest pilot customer. Ahmet runs the platform team.\n\n## Notes\nRenewal talk in Q3.'
  ),
  company(
    ID.globex,
    'Globex',
    { Website: 'https://globex.example', Industry: 'Energy', location: 'Berlin' },
    '## Overview\nEvaluating Memry for their field engineers.\n\n## Notes\n'
  ),
  company(
    ID.initech,
    'Initech',
    { Industry: 'Software' },
    '## Overview\nSmall team, lots of TPS reports.\n\n## Notes\n'
  ),
  person(
    ID.ahmet,
    'Ahmet Yılmaz',
    {
      Company: [uri(ID.acme)],
      Role: 'Engineering lead',
      Email: 'ahmet@acme.example',
      Phone: '+90 532 000 00 01'
    },
    '## Context\nMet at the Istanbul dev meetup. Cares about offline sync.\n\n## Notes\nPrefers async updates over calls.'
  ),
  person(
    ID.elif,
    'Elif Demir',
    { Company: [uri(ID.globex)], Role: 'Product manager', Email: 'elif@globex.example' },
    '## Context\nIntroduced by Ahmet.\n\n## Notes\n'
  ),
  person(
    ID.mert,
    'Mert Kaya',
    { Company: [uri(ID.acme)], Role: 'Designer' },
    '## Context\nDesign partner on the Acme rollout.\n\n## Notes\n'
  ),
  person(
    ID.zeynep,
    'Zeynep Aydın',
    { Company: [uri(ID.initech)], Role: 'CTO', Email: 'zeynep@initech.example' },
    '## Context\nWants a self-hosted pilot.\n\n## Notes\n'
  ),
  person(
    ID.deniz,
    'Deniz Arslan',
    {},
    '## Context\nFreelancer, met at a conference.\n\n## Notes\n'
  ),
  person(
    ID.can,
    'Can Öztürk',
    {
      Company: [uri(ID.acme)],
      Role: 'Backend engineer',
      Team: 'Platform',
      'Start date': seedDateOnly(-120),
      Manager: [uri(ID.ahmet)]
    },
    '## Context\nJoined Acme platform this year.\n\n## Notes\n',
    'employee'
  ),
  person(
    ID.cansu,
    'Cansu Aksoy',
    { Company: [uri(ID.acme)], Team: 'Design', Manager: [uri(ID.ahmet)] },
    '## Context\nWorks with Mert on the design system.\n\n## Notes\n',
    'employee'
  ),
  meeting(
    'Acme kickoff',
    -21,
    [ID.ahmet, ID.mert],
    ID.acme,
    '## Agenda\nScope and timeline.\n\n## Notes\nPilot with 40 seats.\n\n## Action items\n- Send the pilot plan'
  ),
  meeting(
    'Acme sync',
    -7,
    [ID.ahmet, ID.can, ID.cansu],
    ID.acme,
    '## Agenda\nRollout status.\n\n## Notes\nSync is fine on their VPN.\n\n## Action items\n'
  ),
  meeting(
    'Acme roadmap review',
    2,
    [ID.ahmet, ID.mert],
    ID.acme,
    '## Agenda\nQ3 roadmap.\n\n## Notes\n\n## Action items\n'
  ),
  meeting(
    'Globex intro',
    -10,
    [ID.elif],
    ID.globex,
    '## Agenda\nDemo for field engineers.\n\n## Notes\nThey need iOS first.\n\n## Action items\n'
  ),
  meeting(
    'Initech review',
    -3,
    [ID.zeynep],
    ID.initech,
    '## Agenda\nSelf-hosting questions.\n\n## Notes\n\n## Action items\n'
  ),
  meeting(
    '1:1 with Ahmet',
    0,
    [ID.ahmet],
    null,
    '## Agenda\nCareer, hiring.\n\n## Notes\n\n## Action items\n'
  ),
  book(
    'The Pragmatic Programmer',
    { author: 'Andy Hunt, Dave Thomas', Shelf: 'Read', rating: 5, finished: seedDateOnly(-60) },
    '## Highlights\nCare about your craft.\n\n## Thoughts\n'
  ),
  book(
    'Kürk Mantolu Madonna',
    { author: 'Sabahattin Ali', Shelf: 'Reading' },
    '## Highlights\n\n## Thoughts\n'
  ),
  book(
    'Thinking, Fast and Slow',
    { author: 'Daniel Kahneman', Shelf: 'To read' },
    '## Highlights\n\n## Thoughts\n'
  ),
  plain(
    'Hiring plan',
    ['work'],
    'Two backend roles. Ask [[Ahmet Yılmaz]] for referrals; every #person we talk to goes in the pipeline.'
  ),
  plain(
    'Conference contacts',
    [],
    'Met a #person from Globex who knows [[Elif Demir]]. Follow up after the #meeting next week.'
  ),
  plain(
    'Initech notes',
    [],
    'Initech is a #company worth watching. [[Zeynep Aydın]] wants a self-hosted trial.'
  )
]

export const OBJECT_FOLDER_CONFIGS = [
  { path: 'people', icon: '👤' },
  { path: 'companies', icon: '🏢' },
  { path: 'meetings', icon: '📅' }
]

export const OBJECT_NOTE_FILES: NoteFile[] = OBJECT_NOTES.map((note) => ({
  relativePath: note.path,
  frontmatter: note.frontmatter,
  body: note.body,
  modified: MODIFIED
}))

export const OBJECT_NOTE_METADATA: SeedNoteMetadata[] = OBJECT_NOTES.map((note) => ({
  id: note.id,
  path: note.path,
  title: note.title,
  createdAt: seedPastISOAt(Math.min(0, -note.daysAgo), 10, 0),
  modifiedAt: MODIFIED
}))

const DELEGATED: Array<{ title: string; waitingOn: string; followUp: number; thread?: string }> = [
  {
    title: 'Pilot plan sign-off',
    waitingOn: ID.ahmet,
    followUp: 2,
    thread: 'https://mail.example/acme-pilot'
  },
  { title: 'Security questionnaire', waitingOn: ID.zeynep, followUp: 5 },
  {
    title: 'Globex iOS requirements',
    waitingOn: ID.elif,
    followUp: -1,
    thread: 'https://mail.example/globex-ios'
  },
  { title: 'Design system tokens review', waitingOn: ID.mert, followUp: 7 }
]

export const OBJECT_TASKS: SeedTask[] = DELEGATED.map((task, index) => ({
  id: generateId(),
  projectId: PROJECT_IDS.memry,
  statusId: STATUS_IDS.memryReview,
  title: task.title,
  position: 1000 + index,
  fields: stampVersionedMapPatch(
    {},
    {
      'Waiting on': [uri(task.waitingOn)],
      'Follow up': seedDateOnly(task.followUp),
      ...(task.thread ? { Thread: task.thread } : {})
    },
    0
  )
}))

export const OBJECT_TASK_TAGS: SeedTaskTag[] = OBJECT_TASKS.map((task) => ({
  taskId: task.id,
  tag: 'delegated'
}))
