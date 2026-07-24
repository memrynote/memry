import { generateId } from '../../src/main/lib/id'
import type { SeedProjectLink } from '../seed-vault/db-writer'
import { CALENDAR_EVENTS } from './calendar'
import { NOTE_IDS } from './notes'
import { PROJECT_IDS } from './tasks'

// ============================================================================
// Project Home links — the `project_links` rows behind the Notes and Events
// sections (and the note/event counts in the stats row) on Project Home.
//
// The overview note at the top of the page is `projects.home_note_id`, seeded
// alongside PROJECTS in ./tasks.
//
// `file` links are deliberately absent: binary files get their id assigned by
// the indexer at vault-open time (indexBinaryFile → generateNoteId), so a
// pre-seeded file id would never match and the link would dangle.
// ============================================================================

/** Nth event with this title (Deep work blocks repeat the same title). */
function eventId(title: string, occurrence = 0): string {
  const matches = CALENDAR_EVENTS.filter((e) => e.title === title)
  const event = matches[occurrence]
  if (!event) {
    throw new Error(`seed project links: calendar event not found: ${title} #${occurrence}`)
  }
  return event.id
}

interface ProjectLinkSpec {
  projectId: string
  notes: string[]
  events: string[]
}

const SPECS: ProjectLinkSpec[] = [
  {
    projectId: PROJECT_IDS.memry,
    notes: [
      NOTE_IDS.projMemryRoadmap,
      NOTE_IDS.projMemryArchitecture,
      NOTE_IDS.projMemryGTM,
      NOTE_IDS.techCRDTArchitecture,
      NOTE_IDS.techElectronGotchas
    ],
    events: [
      eventId('Sprint planning'),
      eventId('Daily standup'),
      eventId('Inbox snooze ship review'),
      eventId('LocalFirst Conf')
    ]
  },
  {
    projectId: PROJECT_IDS.istanbulWeekend,
    notes: [NOTE_IDS.travelPackingList, NOTE_IDS.travelAirportLounges],
    events: [eventId('Bosphorus ferry — evening route'), eventId('Dinner — Kadıköy')]
  },
  {
    projectId: PROJECT_IDS.reading,
    notes: [
      NOTE_IDS.bookDune,
      NOTE_IDS.bookProjectHailMary,
      NOTE_IDS.bookFourThousandWeeks,
      NOTE_IDS.bookAtomicHabits,
      NOTE_IDS.bookOnWriting
    ],
    events: [eventId('Movie — Dune Part Two')]
  },
  {
    projectId: PROJECT_IDS.fitness,
    notes: [
      NOTE_IDS.weightTrainingSplit,
      NOTE_IDS.weightCardioPlan,
      NOTE_IDS.weightProteinTargets,
      NOTE_IDS.weightSundayWeighIn
    ],
    events: [
      eventId('🏋️ Lift — Lower'),
      eventId('🏋️ Lift — Upper'),
      eventId('🏃 Cardio — Zone 2'),
      eventId('Squat PR session'),
      eventId('Annual physical')
    ]
  },
  {
    projectId: PROJECT_IDS.tokyo,
    notes: [
      NOTE_IDS.travelKyotoDayTrip,
      NOTE_IDS.travelOsakaRamen,
      NOTE_IDS.travelTokyoCafes,
      NOTE_IDS.travelPackingList
    ],
    events: [
      eventId('Tokyo flight'),
      eventId('Tokyo — Ghibli Museum'),
      eventId('Dinner — Tonkatsu Maisen')
    ]
  },
  {
    projectId: PROJECT_IDS.side,
    notes: [
      NOTE_IDS.projBlogRedesign,
      NOTE_IDS.projOpenSourceFork,
      NOTE_IDS.projConferenceTalk,
      NOTE_IDS.techRustNotes
    ],
    events: [eventId('CMU 15-445: Query Optimization (replay)'), eventId('🧠 Deep work — writing')]
  }
]

export const PROJECT_LINKS: SeedProjectLink[] = SPECS.flatMap((spec) => [
  ...spec.notes.map((itemId, position) => ({
    id: generateId(),
    projectId: spec.projectId,
    itemType: 'note' as const,
    itemId,
    position
  })),
  ...spec.events.map((itemId, position) => ({
    id: generateId(),
    projectId: spec.projectId,
    itemType: 'calendar_event' as const,
    itemId,
    position
  }))
])
