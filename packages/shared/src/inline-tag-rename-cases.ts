/**
 * Test cases both inline-tag rewriters must pass: the markdown path
 * (`rewriteInlineTagsInMarkdown`) and the live-doc path (desktop
 * `rename-tag-in-doc.ts`). A case is a run of text pieces; `code` pieces are
 * inline code (backticks in markdown, the `code` mark in a doc) and `bold`
 * pieces only split the doc into formatting runs. `expected` is the plain text
 * after the rename, code text included.
 */
import type { TagRename } from './inline-tags'

export interface InlineTagRenameCase {
  name: string
  pieces: Array<{ text: string; code?: boolean; bold?: boolean }>
  renames: TagRename[]
  expected: string
}

const person: TagRename[] = [{ from: 'person', to: 'people' }]

export const INLINE_TAG_RENAME_CASES: InlineTagRenameCase[] = [
  {
    name: 'whole tags and children only',
    pieces: [{ text: '#person met #Person/VIP and #personal #person-x' }],
    renames: person,
    expected: '#people met #people/VIP and #personal #person-x'
  },
  {
    name: 'a # inside a word starts no tag',
    pieces: [{ text: 'mail@x#person a#person' }],
    renames: person,
    expected: 'mail@x#person a#person'
  },
  {
    name: 'code is left alone',
    pieces: [{ text: 'see ' }, { text: '#person', code: true }, { text: ' and #person' }],
    renames: person,
    expected: 'see #person and #people'
  },
  {
    name: 'a tag right after code reads the character before the code',
    pieces: [{ text: 'x ' }, { text: 'code', code: true }, { text: '#person' }],
    renames: person,
    expected: 'x code#people'
  },
  {
    name: 'a tag right after code that follows a word is no tag',
    pieces: [{ text: 'x' }, { text: 'code', code: true }, { text: '#person' }],
    renames: person,
    expected: 'xcode#person'
  },
  {
    name: 'a tag split across formatting runs',
    pieces: [{ text: 'met #per', bold: true }, { text: 'son/VIP today' }],
    renames: person,
    expected: 'met #people/VIP today'
  },
  {
    name: 'mixed case parent, child suffix keeps its spelling',
    pieces: [{ text: '#WORK/Deep #work' }],
    renames: [{ from: 'Work', to: 'job' }],
    expected: '#job/Deep #job'
  }
]
