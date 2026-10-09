/**
 * The one list of ready-made tags. Names are keys in the `notes` namespace
 * (`tagFields.presets.*`), localized in the app language when a preset is
 * added. Pure data; the seed imports it too.
 *
 * Text-like fields get a `text` property definition. Safe for every peer that
 * syncs `property_definition`: that sync and the text/number/url file schemas
 * first shipped together (v2026-09-09).
 */
import type { FieldType, PresetKey } from '@memry/contracts/tag-schema'

export interface PresetFieldSpec {
  nameKey: string
  type: Exclude<FieldType, 'relation'> | 'relation'
  options?: Array<{ valueKey: string; color: string }>
  showOnCalendar?: boolean
  relation?: { target: PresetKey; many: boolean; inverseKey: string }
}

export interface PresetSpec {
  key: PresetKey
  nameKey: string
  icon: string
  color: string
  fields: PresetFieldSpec[]
  /** Body: `## {heading}` then the hint line, per section. */
  template: { nameKey: string; sections: Array<{ headingKey: string; hintKey?: string }> }
}

const P = 'notes:tagFields.presets'

export const PRESET_CATALOG: readonly PresetSpec[] = [
  {
    key: 'person',
    nameKey: `${P}.person.name`,
    icon: 'icon:UserIcon',
    color: 'sky',
    fields: [
      {
        nameKey: `${P}.person.fields.company`,
        type: 'relation',
        relation: { target: 'company', many: false, inverseKey: `${P}.person.inverse.company` }
      },
      { nameKey: `${P}.person.fields.role`, type: 'text' },
      { nameKey: `${P}.person.fields.email`, type: 'text' },
      { nameKey: `${P}.person.fields.phone`, type: 'text' }
    ],
    template: {
      nameKey: `${P}.person.template.name`,
      sections: [
        { headingKey: `${P}.person.template.context`, hintKey: `${P}.person.template.contextHint` },
        { headingKey: `${P}.person.template.notes` }
      ]
    }
  },
  {
    key: 'company',
    nameKey: `${P}.company.name`,
    icon: 'icon:Building03Icon',
    color: 'indigo',
    fields: [
      { nameKey: `${P}.company.fields.website`, type: 'url' },
      { nameKey: `${P}.company.fields.industry`, type: 'text' },
      { nameKey: `${P}.company.fields.location`, type: 'text' }
    ],
    template: {
      nameKey: `${P}.company.template.name`,
      sections: [
        {
          headingKey: `${P}.company.template.overview`,
          hintKey: `${P}.company.template.overviewHint`
        },
        { headingKey: `${P}.company.template.notes` }
      ]
    }
  },
  {
    key: 'meeting',
    nameKey: `${P}.meeting.name`,
    icon: 'icon:Calendar03Icon',
    color: 'amber',
    fields: [
      { nameKey: `${P}.meeting.fields.date`, type: 'date', showOnCalendar: true },
      {
        nameKey: `${P}.meeting.fields.attendees`,
        type: 'relation',
        relation: { target: 'person', many: true, inverseKey: `${P}.meeting.inverse.attendees` }
      },
      {
        nameKey: `${P}.meeting.fields.company`,
        type: 'relation',
        relation: { target: 'company', many: false, inverseKey: `${P}.meeting.inverse.company` }
      }
    ],
    template: {
      nameKey: `${P}.meeting.template.name`,
      sections: [
        { headingKey: `${P}.meeting.template.agenda` },
        { headingKey: `${P}.meeting.template.notes` },
        { headingKey: `${P}.meeting.template.actionItems` }
      ]
    }
  },
  {
    key: 'book',
    nameKey: `${P}.book.name`,
    icon: 'icon:BookOpen01Icon',
    color: 'emerald',
    fields: [
      { nameKey: `${P}.book.fields.author`, type: 'text' },
      {
        nameKey: `${P}.book.fields.shelf`,
        type: 'select',
        options: [
          { valueKey: `${P}.book.shelf.toRead`, color: 'stone' },
          { valueKey: `${P}.book.shelf.reading`, color: 'amber' },
          { valueKey: `${P}.book.shelf.read`, color: 'green' }
        ]
      },
      { nameKey: `${P}.book.fields.rating`, type: 'number' },
      { nameKey: `${P}.book.fields.finished`, type: 'date' }
    ],
    template: {
      nameKey: `${P}.book.template.name`,
      sections: [
        { headingKey: `${P}.book.template.highlights` },
        { headingKey: `${P}.book.template.thoughts` }
      ]
    }
  }
]

export function presetSpec(key: PresetKey): PresetSpec {
  const spec = PRESET_CATALOG.find((entry) => entry.key === key)
  if (!spec) throw new Error(`Unknown preset ${key}`)
  return spec
}
