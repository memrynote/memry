import { serializePortalDefinition, type PortalTarget } from '@memry/shared/portal-block'
import { generateNoteId } from '../../src/main/lib/id'
import type { NoteFile } from '../seed-vault/file-writer'
import { seedPastISOAt } from './date'

// ============================================================================
// Portals demo — a small study vault where one block shows up in several notes.
//
//   Lecture 1          the source: DNA and its children carry `^anchors`
//   Lecture 2          a folded DNA portal that shows one child it created, and
//                      a two-root portal (RNA and proteins)
//   Exam prep          an opened portal, a whole-note portal, a search portal,
//                      and a `[[Lecture 1#^dna1]]` link (counts as usage)
//   Cell glossary      the note Exam prep shows whole
//   Cardiac arrest     a deeper source, for the toolbar's path crumbs
//   ACLS drills        a portal of a nested child with siblings left out
//
// Fences are written through the shared serializer, so the seed cannot drift
// from the v1 format (docs/protocol/12-note-body-format.md §12.6.3). Anchors are
// the trailing ` ^id` the app stamps on a block it must reference.
// ============================================================================

export const PORTAL_NOTE_IDS = {
  lecture1: generateNoteId(),
  lecture2: generateNoteId(),
  examPrep: generateNoteId(),
  glossary: generateNoteId(),
  cardiacArrest: generateNoteId(),
  aclsDrills: generateNoteId()
}

export const PORTAL_NOTE_PATHS = {
  lecture1: 'study/Lecture 1.md',
  lecture2: 'study/Lecture 2.md',
  examPrep: 'study/Exam prep.md',
  glossary: 'study/Cell glossary.md',
  cardiacArrest: 'study/Cardiac arrest.md',
  aclsDrills: 'study/ACLS drills.md'
}

const MODIFIED = seedPastISOAt(-1, 10, 15)

/** A `memry-portal` fence exactly as the editor writes it to the file. */
export function portalFence(target: PortalTarget): string {
  return ['```memry-portal', serializePortalDefinition({ v: 1, target, raw: {} }), '```'].join('\n')
}

const blocks = (
  note: string,
  roots: string[],
  open: Record<string, { mode: 'show' | 'hide'; ids: string[] }> = {}
): PortalTarget => ({ kind: 'blocks', note, blocks: roots, open })

const LECTURE_1_BODY = `- Cells keep their instructions in DNA
- DNA ^dna1
  - double helix shape ^helx
  - DNA is made of purines and pyrimidines ^purpyr
  - Base pairs: A with T, C with G ^pairs
- RNA copies DNA to build proteins ^rna1
- Proteins fold into 3D shapes ^prot
`

const LECTURE_2_BODY = `- Today: the structure of DNA

${portalFence(blocks(PORTAL_NOTE_IDS.lecture1, ['dna1'], { dna1: { mode: 'show', ids: ['purpyr'] } }))}

- Next: how the code becomes a protein

${portalFence(blocks(PORTAL_NOTE_IDS.lecture1, ['rna1', 'prot']))}

- Questions for the seminar
`

const GLOSSARY_BODY = `- Nucleotide: one building block of DNA or RNA
- Purine: adenine and guanine
- Pyrimidine: cytosine, thymine and uracil
- Ribosome: the machine that reads RNA
`

const EXAM_PREP_BODY = `- Review before Friday: [[Lecture 1#^dna1]]

${portalFence(blocks(PORTAL_NOTE_IDS.lecture1, ['dna1'], { dna1: { mode: 'hide', ids: [] } }))}

- Terms to know

${portalFence({ kind: 'note', note: PORTAL_NOTE_IDS.glossary, hide: [] })}

- Everything I wrote about DNA

${portalFence({ kind: 'search', text: 'DNA', limit: 20 })}
`

const CARDIAC_ARREST_BODY = `- Cardiac arrest ^cara
  - 50-year-old patient, unwitnessed collapse ^pt50
    - First step: check for a pulse ^pulse
    - Return of circulation: check pulse and rhythm ^rosc
      - Oxygen saturation goal: 94% or higher ^sat94
      - End-tidal CO2 goal: 35 to 40 ^etco2
`

const ACLS_DRILLS_BODY = `- Drill 3: after the shock

${portalFence(
  blocks(PORTAL_NOTE_IDS.cardiacArrest, ['rosc'], { rosc: { mode: 'show', ids: ['sat94'] } })
)}

- Debrief
`

interface PortalSeedNote {
  key: keyof typeof PORTAL_NOTE_IDS
  title: string
  body: string
  tags: string[]
  created: number
}

const NOTES_SPEC: PortalSeedNote[] = [
  { key: 'lecture1', title: 'Lecture 1', body: LECTURE_1_BODY, tags: ['study'], created: -9 },
  { key: 'lecture2', title: 'Lecture 2', body: LECTURE_2_BODY, tags: ['study'], created: -6 },
  { key: 'examPrep', title: 'Exam prep', body: EXAM_PREP_BODY, tags: ['study'], created: -5 },
  { key: 'glossary', title: 'Cell glossary', body: GLOSSARY_BODY, tags: ['study'], created: -8 },
  {
    key: 'cardiacArrest',
    title: 'Cardiac arrest',
    body: CARDIAC_ARREST_BODY,
    tags: ['study'],
    created: -7
  },
  { key: 'aclsDrills', title: 'ACLS drills', body: ACLS_DRILLS_BODY, tags: ['study'], created: -4 }
]

export const PORTAL_METADATA = NOTES_SPEC.map((n) => ({
  id: PORTAL_NOTE_IDS[n.key],
  path: PORTAL_NOTE_PATHS[n.key],
  title: n.title,
  emoji: null,
  createdAt: seedPastISOAt(n.created, 9, 30),
  modifiedAt: MODIFIED
}))

export const PORTAL_NOTES: NoteFile[] = NOTES_SPEC.map((n) => ({
  relativePath: PORTAL_NOTE_PATHS[n.key],
  frontmatter: { tags: n.tags },
  body: n.body,
  modified: MODIFIED
}))
