import type { FoldLayers, FoldParagraph, FoldToken } from '@memry/contracts/note-fold'

/** Words, whitespace runs and single marks, like the engine's Intl.Segmenter pass. */
export function tokenize(text: string): string[] {
  return text.match(/\s+|[\p{L}\p{N}']+|[^\s\p{L}\p{N}]/gu) ?? []
}

/** An AI line's tokens, each word pointing at the first unused source token with the same text. */
export function mapTokens(text: string | null, srcTokens: readonly string[]): FoldToken[] | null {
  if (text === null) return null
  const used = new Set<number>()
  return tokenize(text).map((token) => {
    const src = /^\s+$/.test(token)
      ? -1
      : srcTokens.findIndex((s, i) => !used.has(i) && s.toLowerCase() === token.toLowerCase())
    if (src >= 0) used.add(src)
    return { text: token, src: src >= 0 ? src : null }
  })
}

export function paragraph(overrides: Partial<FoldParagraph> & { hash: string }): FoldParagraph {
  const base = {
    text: 'First sentence here. Second sentence here. Third sentence here.',
    sentences: ['First sentence here.', 'Second sentence here.', 'Third sentence here.'],
    briefIdx: [0, 2],
    key: null,
    takeaway: null,
    topic: null,
    evidence: [],
    ...overrides
  }
  const srcTokens = overrides.srcTokens ?? tokenize(base.text)
  // Sentence i starts at the token holding its first character.
  let from = 0
  const srcSentenceStart = base.sentences.map((sentence) => {
    from = Math.max(from, base.text.indexOf(sentence, from))
    let chars = 0
    const start = srcTokens.findIndex((token) => (chars += token.length) > from)
    return Math.max(start, 0)
  })
  return {
    sentencesMd: base.sentences,
    srcTokens,
    srcSentenceStart,
    morph: {
      keyTakeaway: mapTokens(base.key?.takeaway ?? null, srcTokens),
      keyReason: mapTokens(base.key?.reason ?? null, srcTokens),
      takeaway: mapTokens(base.takeaway, srcTokens),
      topic: mapTokens(base.topic, srcTokens)
    },
    ...base,
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
        skipped: [],
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
        skipped: [],
        paragraphs: [paragraph({ hash: 'p3', text: 'Next steps are the changelog and the email.' })]
      }
    ],
    ready: ['key', 'takeaway', 'topic'],
    status: 'ready',
    agent: 'Claude Code',
    ...overrides
  }
}
