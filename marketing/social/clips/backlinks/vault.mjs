// Homepage Ideas with real backlinks (the rest of Maya's month, ../graph-edit/world.mjs: the sync
// with Sam, Design Principles, Lea's feedback and the hero copy point at it) and a body long enough
// that its links sections follow the text. The sync with Sam already names a note nobody has
// written yet, Photo shoot plan: the link that waits.
import { addWorld } from '../graph-edit/world.mjs'

export default function ({ cli }) {
  const notes = addWorld(cli)
  cli(
    'notes',
    'update',
    notes['Homepage Ideas'].id,
    '--content',
    `Lead with one calm line, then the work. One big photo of a building, one sentence, one button.

Pulled from [[Studio North Kickoff]] and [[Design Principles]].

Next steps
- Pick the hero photo
- Write the case study intro
`
  )
  cli(
    'notes',
    'update',
    notes['Weekly sync with Sam'].id,
    '--content',
    `- Sam needs the hero assets by Thursday
- Mobile nav: prototype both the menu and a bottom bar
- [[Homepage Ideas]] approved for build
- He wants the [[Photo shoot plan]] by Friday
`
  )
}
