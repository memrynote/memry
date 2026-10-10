// People and companies: objects of the ready-made #person and #company tags,
// plus two #client companies (#client extends #company) and the client meetings.
// Field values are top-level frontmatter keys named like the field; a relation
// is a list of `memry://note/<id>` even when it holds one. Email addresses use
// example.com and phone numbers the 555 range.
import type { Body } from '../body.ts'
import type { Clock } from '../clock.ts'
import type { NoteSpec } from '../specs.ts'

const PEOPLE = 'People'
const COMPANIES = 'Companies'

interface PersonSpec {
  key: string
  name: string
  role: string
  company?: string
  email: string
  phone: string
  created: number
  body: string
}

const people: PersonSpec[] = [
  {
    key: 'pe-maya',
    name: 'Maya Okafor',
    role: 'Product designer',
    company: 'co-fieldwork',
    email: 'maya.okafor@example.com',
    phone: '+1 555 0101',
    created: 90,
    body: `## Context

This is me. Product designer at Fieldwork, working on [[Aurora product brief|Aurora]] and, on the side, an essay about [[Notes in the space race|how people kept notes in the space race]].

## Notes

Keeping myself in the list means meetings can list me as an attendee, and my own page shows everything I have been in.
`
  },
  {
    key: 'pe-lena',
    name: 'Lena Visser',
    role: 'Design director',
    company: 'co-fieldwork',
    email: 'lena.visser@example.com',
    phone: '+1 555 0102',
    created: 90,
    body: `## Context

Runs the studio. Hired me three years ago and still reads every critique doc. Signed off the [[Typography spec (signed off)]].

## Notes

- Prefers a one-page brief to a deck
- 1:1 every other week, usually at 15:00
- Asks "what would we cut?" in every review
`
  },
  {
    key: 'pe-theo',
    name: 'Theo Bakker',
    role: 'Engineer',
    company: 'co-fieldwork',
    email: 'theo.bakker@example.com',
    phone: '+1 555 0103',
    created: 80,
    body: `## Context

Builds the sync engine and the highlight store for Aurora. Prototyped both options in the [[Decision log#Highlights sync|highlights sync decision]].

## Notes

- Pushes back on anything that clutters the toolbar, usually correctly
- Best reached in the morning; deep work after lunch
`
  },
  {
    key: 'pe-priya',
    name: 'Priya Nair',
    role: 'Engineer',
    company: 'co-fieldwork',
    email: 'priya.nair@example.com',
    phone: '+1 555 0104',
    created: 80,
    body: `## Context

Owns the reading view and the night theme on the engineering side. Wrote the contrast numbers that went into the [[Reading view critique]].

## Notes

Pairs well with Sam on anything visual.
`
  },
  {
    key: 'pe-sam',
    name: 'Sam Rivera',
    role: 'Visual designer',
    company: 'co-fieldwork',
    email: 'sam.rivera@example.com',
    phone: '+1 555 0105',
    created: 45,
    body: `## Context

Joined the critique with the library photo that reframed the reading view: see [[Reading view critique]].

## Notes

Freelances for us two days a week. Icon set v2 was theirs.
`
  },
  {
    key: 'pe-anouk',
    name: 'Anouk de Wit',
    role: 'Product lead',
    company: 'co-northlight',
    email: 'anouk.dewit@example.com',
    phone: '+1 555 0111',
    created: 30,
    body: `## Context

Our contact at Northlight Health. Wants the patient reading experience to feel as calm as Aurora; that is why they hired the studio.

## Notes

- Prefers email to calls
- Decides scope herself, but wants it in writing before a sprint starts
`
  },
  {
    key: 'pe-marcus',
    name: 'Marcus Obi',
    role: 'Operations lead',
    company: 'co-brightwater',
    email: 'marcus.obi@example.com',
    phone: '+1 555 0112',
    created: 9,
    body: `## Context

Brightwater's first call came through a referral. Runs operations for the co-op and owns the budget.

## Notes

Discovery call is on the calendar. Questions are in [[Brightwater discovery call]].
`
  },
  {
    key: 'pe-harriet',
    name: 'Harriet Cole',
    role: 'Acquiring editor',
    company: 'co-harbor',
    email: 'harriet.cole@example.com',
    phone: '+1 555 0121',
    created: 40,
    body: `## Context

Editor at Harbor Lane Press. Asked for the essay after reading an early outline.

## Notes

She wants the draft by the date on the calendar and a one-paragraph pitch. Draft lives in [[Space race essay draft]].
`
  },
  {
    key: 'pe-jonah',
    name: 'Jonah Eriksen',
    role: 'Friend',
    email: 'jonah.eriksen@example.com',
    phone: '+1 555 0131',
    created: 60,
    body: `## Context

Old friend, hikes with Ines and me. Coming to the Tetons: see [[Grand Teton trip]].

## Notes

No company on his page on purpose: a field can stay empty.
`
  }
]

interface CompanySpec {
  key: string
  name: string
  client?: 'Retainer' | 'Fixed price' | 'Pilot'
  website: string
  industry: string
  location: string
  created: number
  body: string
}

const companies: CompanySpec[] = [
  {
    key: 'co-fieldwork',
    name: 'Fieldwork',
    website: 'https://fieldwork.example.com',
    industry: 'Product design studio',
    location: 'Rotterdam',
    created: 90,
    body: `## Overview

Five people, one big room, two products at a time. How the studio runs is written down in [[Studio rituals]].

## Notes

Current work: [[Aurora product brief|Aurora]], plus client projects for Northlight Health and, soon, Brightwater Co-op.
`
  },
  {
    key: 'co-northlight',
    name: 'Northlight Health',
    client: 'Retainer',
    website: 'https://northlight.example.com',
    industry: 'Healthcare software',
    location: 'Utrecht',
    created: 40,
    body: `## Overview

Patient-facing reading and onboarding tools. Our longest-running client: a monthly retainer for design and prototyping.

## Notes

Invoices go out on the first working day. See [[Northlight kickoff]] for the scope we agreed.
`
  },
  {
    key: 'co-brightwater',
    name: 'Brightwater Co-op',
    client: 'Pilot',
    website: 'https://brightwater.example.com',
    industry: 'Food retail',
    location: 'Gent',
    created: 9,
    body: `## Overview

A grocery co-operative that wants a calmer ordering app. Starts as a six-week pilot.

## Notes

Nothing signed yet. The quote is with [[Marcus Obi]].
`
  },
  {
    key: 'co-harbor',
    name: 'Harbor Lane Press',
    website: 'https://harborlane.example.com',
    industry: 'Publishing',
    location: 'Amsterdam',
    created: 40,
    body: `## Overview

Independent publisher of essays and long reads. Not a client: they might publish the space race essay.

## Notes

Contact: [[Harriet Cole]].
`
  }
]

const uri = (b: Body, key: string): string[] => [b.uri.note(key)]

export const peopleNotes: NoteSpec[] = people.map((person) => ({
  key: person.key,
  title: person.name,
  folder: PEOPLE,
  tags: ['person'],
  created: person.created,
  modified: Math.max(1, Math.round(person.created / 4)),
  properties: (b) => ({
    ...(person.company ? { Company: uri(b, person.company) } : {}),
    Role: person.role,
    Email: person.email,
    Phone: person.phone
  }),
  body: () => person.body
}))

export const companyNotes: NoteSpec[] = companies.map((company) => ({
  key: company.key,
  title: company.name,
  folder: COMPANIES,
  tags: [company.client ? 'client' : 'company'],
  created: company.created,
  modified: Math.max(1, Math.round(company.created / 4)),
  properties: () => ({
    ...(company.client ? { Contract: company.client } : {}),
    Website: company.website,
    Industry: company.industry,
    Location: company.location
  }),
  body: () => company.body
}))

/** Client meetings: objects of #meeting, one past and one upcoming. */
export function clientMeetings(clock: Clock): NoteSpec[] {
  const upcoming = clock.workdays(3, 9)[0]
  return [
    {
      key: 'northlight-kickoff',
      title: 'Northlight kickoff',
      folder: 'Work/Clients',
      tags: ['meeting'],
      created: 12,
      modified: 12,
      properties: (b) => ({
        Date: b.day(-12),
        Attendees: [b.uri.note('pe-maya'), b.uri.note('pe-lena'), b.uri.note('pe-anouk')],
        Company: uri(b, 'co-northlight')
      }),
      body: () => `## Agenda

1. What "calm" means for patients reading discharge notes
2. Scope for the first six weeks
3. Who signs off what

## Notes

- Anouk wants three screens at most: the document, a glossary sheet, a share sheet
- Accessibility first: type size follows the system, no information in color alone
- Weekly check-in on Thursdays, 30 minutes

## Action items

- Maya: send a one-page scope by Friday
- Anouk: confirm which documents the data export covers
`
    },
    {
      key: 'brightwater-call',
      title: 'Brightwater discovery call',
      folder: 'Work/Clients',
      tags: ['meeting'],
      created: 3,
      modified: 1,
      properties: (b) => ({
        Date: b.day(upcoming),
        Attendees: [b.uri.note('pe-maya'), b.uri.note('pe-lena'), b.uri.note('pe-marcus')],
        Company: uri(b, 'co-brightwater')
      }),
      body: () => `## Agenda

1. How members order today
2. What a pilot would have to prove in six weeks
3. Budget and timing

## Notes

Questions to ask: how many members order weekly, what happens when something is out of stock, who answers the phone when the app fails.

## Action items

- Send the pilot quote after the call
`
    }
  ]
}
