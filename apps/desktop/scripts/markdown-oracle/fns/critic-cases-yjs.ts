/**
 * Cases of `critic.yjsWrite`: the per-id write and the first-copy-wins read of
 * the `criticMarkupMarks` root (protocol 12.5.1). Each case is a base array and
 * one or more writers, each writing on its own replica of the base.
 */
import type { CriticMarkupMark } from '../../../../../packages/shared/src/critic-markup/parser'
import type { OracleCase } from '../cases-frontmatter'
import { fnCase } from './critic-cases-parse'

const c1: CriticMarkupMark = {
  id: 'c1',
  kind: 'comment',
  visibleText: 'alpha',
  body: 'one',
  metadata: 'id=c1;type=comment',
  start: 0,
  end: 5
}
const c2: CriticMarkupMark = {
  id: 'c2',
  kind: 'substitution',
  visibleText: 'new',
  originalText: 'old',
  start: 10,
  end: 13
}
const c3: CriticMarkupMark = { id: 'c3', kind: 'addition', visibleText: 'more', start: 20, end: 24 }
const rich: CriticMarkupMark = {
  ...c1,
  id: 'rich',
  body: 'see this',
  createdAt: 1748254022000.5,
  mentions: [{ kind: 'note', refId: 'n1', label: 'Plan' }],
  attachments: [{ id: 'a', name: 'n', path: 'p', size: 5, mimeType: 'm', type: 'image' }],
  formatRanges: [{ start: 0, end: 3, marks: ['bold'] }]
}
const future = { flag: true, nested: { v: 2, list: [1, 'x', null] } }
const reversed = (mark: CriticMarkupMark): Record<string, unknown> =>
  Object.fromEntries(Object.entries(mark).toReversed())

const CASES: Record<string, [unknown[], CriticMarkupMark[][]]> = {
  'empty-to-one': [[], [[c1]]],
  'empty-to-empty': [[], [[]]],
  'one-to-empty': [[c1], [[]]],
  'same-marks': [[c1, c2], [[c1, c2]]],
  'same-rich-mark': [[rich], [[rich]]],
  'key-order-only': [[reversed(c1), reversed(rich)], [[c1, rich]]],
  'key-order-nested': [
    [{ ...rich, mentions: [{ label: 'Plan', refId: 'n1', kind: 'note' }] }],
    [[rich]]
  ],
  'unknown-key-kept-unchanged': [[{ ...c1, future }], [[c1]]],
  'unknown-key-kept-on-edit': [[{ ...c1, future }], [[{ ...c1, body: 'edited' }]]],
  'unknown-key-kept-on-move': [[{ ...c1, future }], [[{ ...c1, start: 1, end: 6 }]]],
  'unknown-key-dropped-with-mark': [[{ ...c1, future }, c2], [[c2]]],
  'known-key-removed': [[rich], [[{ ...rich, formatRanges: undefined, mentions: undefined }]]],
  'known-key-invalid-dropped': [[{ ...c1, mentions: 'x' }], [[c1]]],
  'edit-middle': [[c1, c2, c3], [[c1, { ...c2, visibleText: 'newer', end: 15 }, c3]]],
  'delete-middle': [[c1, c2, c3], [[c1, c3]]],
  'insert-first': [[c2, c3], [[c1, c2, c3]]],
  'insert-middle': [[c1, c3], [[c1, c2, c3]]],
  'insert-last': [[c1, c2], [[c1, c2, c3]]],
  'insert-after-reordered': [[c1, c2], [[c2, c3, c1]]],
  'reorder-only': [[c1, c2, c3], [[c3, c1, c2]]],
  'duplicate-ids-repaired': [[c1, { ...c1, body: 'second' }, c2], [[c1, c2]]],
  'duplicate-ids-first-invalid': [
    [
      { ...c1, kind: 'highlight' },
      { ...c1, body: 'valid' }
    ],
    [[{ ...c1, body: 'valid' }]]
  ],
  'duplicate-ids-in-marks': [[], [[c1, { ...c1, body: 'second' }]]],
  'invalid-elements-deleted': [
    [null, 'x', 3, [c1], { ...c1, end: -1 }, { ...c2, kind: 'note' }, c3],
    [[c3]]
  ],
  'invalid-mark-not-written': [[], [[{ ...c1, start: 4, end: 2 }, c2]]],
  'two-writers-same-mark': [[c1], [[{ ...c1, body: 'from a' }], [{ ...c1, body: 'from b' }]]],
  'two-writers-different-marks': [
    [c1, c2],
    [
      [{ ...c1, body: 'from a' }, c2],
      [c1, { ...c2, visibleText: 'from b', end: 16 }]
    ]
  ],
  'two-writers-delete-and-edit': [
    [c1, c2],
    [[c2], [{ ...c1, body: 'kept' }, c2]]
  ],
  'two-writers-both-insert': [
    [c1],
    [
      [c1, c2],
      [c1, c3]
    ]
  ],
  'two-writers-insert-same-id': [[], [[c1], [{ ...c1, body: 'other' }]]],
  'two-writers-one-unchanged': [[{ ...c1, future }], [[c1], [{ ...c1, body: 'edit' }]]],
  'three-writers-same-mark': [
    [c1],
    [[{ ...c1, body: 'a' }], [{ ...c1, body: 'b' }], [{ ...c1, body: 'c' }]]
  ],
  'duplicates-repaired-by-later-write': [
    [c1, { ...c1, body: 'second', future }, c2],
    [
      [c1, c2],
      [c1, c2]
    ]
  ]
}

export function yjsWriteCases(): OracleCase[] {
  return Object.entries(CASES).map(([slug, [base, writes]], index) =>
    fnCase(
      'critic-yjs',
      `${String(index).padStart(3, '0')}-${slug}`,
      'critic.yjsWrite',
      base,
      writes
    )
  )
}
