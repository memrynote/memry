import type { PersistableDefinition } from './properties'

/**
 * Property definitions for the fields of the seeded tags with fields
 * (./objects). Author, Rating, Location and Finished reuse the vault's
 * lowercase `author`, `rating`, `location` and `finished`, as adding a preset
 * in the app does (`canonicalFieldName`), so those get a declared type here.
 */
export const OBJECT_FIELD_DEFINITIONS: PersistableDefinition[] = [
  { name: 'author', type: 'text' },
  { name: 'location', type: 'text' },
  { name: 'rating', type: 'number' },
  { name: 'Role', type: 'text' },
  { name: 'Email', type: 'text' },
  { name: 'Phone', type: 'text' },
  { name: 'Industry', type: 'text' },
  { name: 'Website', type: 'url' },
  { name: 'Thread', type: 'url' },
  { name: 'Date', type: 'date', showOnCalendar: true },
  { name: 'Start date', type: 'date', showOnCalendar: false },
  { name: 'Follow up', type: 'date', showOnCalendar: true },
  {
    name: 'Shelf',
    type: 'select',
    options: [
      { value: 'To read', color: 'stone' },
      { value: 'Reading', color: 'amber' },
      { value: 'Read', color: 'green' }
    ]
  },
  {
    name: 'Team',
    type: 'select',
    options: [
      { value: 'Platform', color: 'indigo' },
      { value: 'Design', color: 'plum' },
      { value: 'Sales', color: 'amber' }
    ]
  }
]
