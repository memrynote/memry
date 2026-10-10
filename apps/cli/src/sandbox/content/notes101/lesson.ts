// A Notes 101 lesson: tagged, iconed and given `level` and `summary`
// properties for the folder view.
import type { NoteSpec } from '../../specs.ts'

export const FOLDER = 'Notes 101'

type Level = 'Beginner' | 'Intermediate' | 'Advanced'

export function lesson(
  key: string,
  title: string,
  emoji: string,
  level: Level,
  summary: string,
  body: NoteSpec['body'],
  extra: Partial<NoteSpec> = {}
): NoteSpec {
  return {
    key,
    title,
    folder: FOLDER,
    tags: ['notes-101'],
    emoji,
    properties: () => ({ level, summary }),
    body,
    created: 0,
    modified: 0,
    ...extra
  }
}
