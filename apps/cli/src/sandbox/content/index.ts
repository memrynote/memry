import type { Clock } from '../clock.ts'
import type { AssetName } from '../context.ts'
import type { NoteSpec } from '../specs.ts'
import { guideNotes } from './guide.ts'
import { companyNotes, clientMeetings, peopleNotes } from './people.ts'
import { notes101 } from './notes101/index.ts'
import { kitchenNotes, travelNotes, writingNotes } from './life.ts'
import { bookNotes, researchNotes } from './research.ts'
import { workNotes } from './work.ts'

export function noteSpecs(clock: Clock): NoteSpec[] {
  return [
    ...notes101,
    ...guideNotes,
    ...workNotes(clock),
    ...peopleNotes,
    ...companyNotes,
    ...clientMeetings(clock),
    ...researchNotes,
    ...bookNotes,
    ...kitchenNotes,
    ...travelNotes,
    ...writingNotes
  ]
}

/** Binaries that also live in the tree as file notes (bookmarks, canvas cards, project files). */
export const importedFiles: Array<{ key: string; asset: AssetName; folder: string }> = [
  { key: 'gestures-pdf', asset: 'paper-note-taking-gestures.pdf', folder: 'Research/Papers' },
  { key: 'pillars-image', asset: 'photo-pillars-of-creation.jpg', folder: 'Research/Space race' },
  {
    key: 'armstrong-audio',
    asset: 'audio-armstrong-small-step.ogg',
    folder: 'Research/Space race'
  },
  {
    key: 'launch-video',
    asset: 'video-apollo11-launch-commentary.webm',
    folder: 'Research/Space race'
  }
]
