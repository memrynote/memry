/**
 * Class: note-fold (`note-fold.json`).
 *
 * Desktop's own fold engine, imported for real (`apps/desktop/src/main/note-fold/`): each case
 * runs what `fold-service.ts` `get` does before any model is asked (language, inline tokens,
 * the fold threshold, sections and chunks, `assemble` with no model lines), and records the
 * local levels it answers. `levels` lists the levels the file covers; the model levels
 * (Key, Takeaway, Topic) append theirs. Dates format in UTC so the file is the same on every
 * machine. The Rust port (`crates/memry-desktop/src/fold/`) reproduces every case
 * (`crates/memry-desktop/tests/note_fold_vectors.rs`).
 */
// Namespace imports: desktop's sources are CommonJS to Node, and the ESM loader cannot see
// their named exports statically.
import * as engineModule from '../../../../apps/desktop/src/main/note-fold/engine.ts'
import * as tokensModule from '../../../../apps/desktop/src/main/note-fold/engine-tokens.ts'

import { meta } from './shared'
import { NOTE_FOLD_CASES } from './note-fold-cases'
import { NOTE_FOLD_ZONE, withZone } from './note-fold-text'

type Engine = typeof engineModule
type Tokens = typeof tokensModule

const engine: Engine = (engineModule as Engine & { default?: Engine }).default ?? engineModule
const tokens: Tokens = (tokensModule as Tokens & { default?: Tokens }).default ?? tokensModule

function foldCase(markdown: string): Record<string, unknown> {
  const language = engine.detectLanguage(tokens.withoutInlineTokens(markdown))
  const source = tokens.expandInlineTokens(markdown, language)
  const sections = engine.isFoldable(source, language) ? engine.buildSections(source, language) : []
  const { layers } = engine.assemble({
    noteId: 'note',
    source,
    language,
    sections,
    lookup: () => undefined
  })
  return {
    language,
    source,
    sourceHash: layers.sourceHash,
    foldable: sections.length > 0,
    totalWords: layers.totalWords,
    wordsByLevel: { full: layers.wordsByLevel.full, brief: layers.wordsByLevel.brief },
    sections: layers.sections.map((section, i) => ({
      hash: section.hash,
      heading: section.heading,
      skipped: section.skipped,
      chunks: sections[i].chunks.map((chunk) => chunk.hash),
      paragraphs: section.paragraphs.map((p) => ({
        hash: p.hash,
        text: p.text,
        sentences: p.sentences,
        sentencesMd: p.sentencesMd,
        srcTokens: p.srcTokens,
        srcSentenceStart: p.srcSentenceStart,
        briefIdx: p.briefIdx
      }))
    }))
  }
}

export function buildNoteFold(): Record<string, unknown> {
  return withZone(NOTE_FOLD_ZONE, () => ({
    meta: meta({
      source:
        'apps/desktop/src/main/note-fold/{engine,engine-inline,engine-morph,engine-tokens,segmenter}.ts',
      note: 'The local fold of a note: what fold-service.ts get answers with no model lines. Inline date tokens format in timeZone.'
    }),
    levels: ['full', 'brief'],
    timeZone: NOTE_FOLD_ZONE,
    cases: NOTE_FOLD_CASES.map((c) => ({
      name: c.name,
      written: c.written,
      markdown: c.markdown,
      expected: foldCase(c.markdown)
    }))
  }))
}
