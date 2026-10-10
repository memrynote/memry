// "Notes 101": a top-level folder that teaches notes. Every note is a live
// example, with the explanation next to the block it explains. Titles carry a
// number so the sidebar and the folder view order them as a course.
import type { NoteSpec } from '../../specs.ts'
import { blockNotes } from './blocks.ts'
import { linkNotes } from './links.ts'
import { overviewNote } from './overview.ts'
import { textNotes } from './text.ts'
import { toolNotes } from './tools.ts'

export const notes101: NoteSpec[] = [
  overviewNote,
  ...textNotes,
  ...blockNotes,
  ...linkNotes,
  ...toolNotes
]
