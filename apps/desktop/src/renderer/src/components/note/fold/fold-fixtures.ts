import type { FoldLayers, FoldParagraph } from '@memry/contracts/note-fold'

export function paragraph(overrides: Partial<FoldParagraph> & { hash: string }): FoldParagraph {
  return {
    text: 'First sentence here. Second sentence here. Third sentence here.',
    sentences: ['First sentence here.', 'Second sentence here.', 'Third sentence here.'],
    briefIdx: [0, 2],
    key: null,
    takeaway: null,
    topic: null,
    evidence: [],
    ...overrides,
    hash: overrides.hash
  }
}

/** A two-section note. Key, Takeaway and Topic are written unless `ready` says otherwise. */
export function layers(overrides: Partial<FoldLayers> = {}): FoldLayers {
  return {
    noteId: 'note-1',
    sourceHash: 'src',
    language: 'en',
    totalWords: 1104,
    wordsByLevel: { full: 1104, brief: 212, key: 168, takeaway: 46, topic: 12 },
    sections: [
      {
        hash: 's1',
        heading: 'Where we are',
        takeaway: 'The team plan barely sold, so Pro absorbs it',
        paragraphs: [
          paragraph({
            hash: 'p1',
            key: { takeaway: 'The team plan barely sold.', reason: 'Buyers wanted device sync.' },
            takeaway: 'The team plan barely sold',
            topic: 'team plan sales',
            evidence: [1]
          }),
          paragraph({ hash: 'p2', takeaway: 'Pro stays at $8', topic: null })
        ]
      },
      {
        hash: 's2',
        heading: null,
        takeaway: null,
        paragraphs: [paragraph({ hash: 'p3', text: 'Next steps are the changelog and the email.' })]
      }
    ],
    ready: ['key', 'takeaway', 'topic'],
    status: 'ready',
    agent: 'Claude Code',
    ...overrides
  }
}
