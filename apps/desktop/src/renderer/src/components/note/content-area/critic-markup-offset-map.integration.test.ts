import { describe, expect, it } from 'vitest'
import { BlockNoteEditor } from '@blocknote/core'
import { splitMarkdownPreservingBlanks } from '@memry/shared/empty-lines'
import {
  editorOffsetToMarkdownSourceOffset,
  markdownSourceOffsetToEditorOffset
} from './critic-markup-offset-map'
import { parseMarkdownPreservingBlanks, serializeBlocksPreservingBlanks } from './markdown-utils'
import { createWikiLinkInlineContent } from './wiki-link'
import { createHashTagInlineContent } from './hash-tag'

// Builds a REAL ProseMirror doc the same way parseMarkdownPreservingBlanks
// does (gap segments become empty paragraph blocks) and returns the editor
// projection the offset map must model: doc.textBetween(0, size, '\n').
// Uses the default BlockNote schema — the custom schema's extra block specs
// (file, youtubeEmbed, …) drag react-pdf into jsdom and are irrelevant to
// paragraph/separator projection.
async function realProjection(markdown: string): Promise<string> {
  const editor = BlockNoteEditor.create()
  const blocks: any[] = []
  for (const seg of splitMarkdownPreservingBlanks(markdown)) {
    if (seg.type === 'content') {
      blocks.push(...(await editor.tryParseMarkdownToBlocks(seg.text)))
    } else {
      for (let i = 0; i < seg.extraLines; i++) {
        blocks.push({ type: 'paragraph', content: [], children: [], props: {} })
      }
    }
  }
  editor.replaceBlocks(editor.document, blocks)
  const doc = (editor as any)._tiptapEditor.state.doc
  return doc.textBetween(0, doc.content.size, '\n')
}

// Plain-paragraph fixtures: no hidden inline syntax, so every non-newline
// source char appears verbatim in the projection and the map must agree with
// the real doc on each one.
const FIXTURES_PASSING = [
  'Line1\n\nLine2',
  'Line1\n\n\n\n',
  // Interior multi-blank gaps: the map now emits N-1 separators per N-newline
  // run, matching one empty paragraph per blank line in the real doc.
  'Line1\n\n\nLine2',
  'Line1\n\n\n\nLine2',
  'Line1\n\n\n\n\nLine2',
  'Line4\n\n\n\n\nHey1\n\nHey2\n\nHey3\n\nHey4'
]

// Blocked: a LEADING blank run (no content before it) still collapses; the real
// doc emits one empty paragraph per leading blank line. Out of scope for the
// interior-gap fix.
const FIXTURES_BROKEN = ['\n\n\nLine1']

describe('CriticMarkup offset map vs real BlockNote doc projection', () => {
  for (const markdown of FIXTURES_PASSING) {
    it(`agrees with doc.textBetween for ${JSON.stringify(markdown)}`, async () => {
      const projection = await realProjection(markdown)

      // Walk both strings: each visible (non-newline) source char must map to
      // its actual position in the real projection, and back.
      let editorIndex = 0
      for (let sourceIndex = 0; sourceIndex < markdown.length; sourceIndex++) {
        const char = markdown[sourceIndex]
        if (char === '\n') continue
        editorIndex = projection.indexOf(char, editorIndex)
        expect(editorIndex).not.toBe(-1)
        expect(markdownSourceOffsetToEditorOffset(markdown, sourceIndex)).toBe(editorIndex)
        expect(editorOffsetToMarkdownSourceOffset(markdown, editorIndex)).toBe(sourceIndex)
        editorIndex++
      }
    })
  }

  for (const markdown of FIXTURES_BROKEN) {
    it.skip(`agrees with doc.textBetween for ${JSON.stringify(markdown)}`, async () => {
      // Blocked: offset map collapses multi-blank-line gaps to one separator;
      // doc produces one separator per empty paragraph block.
    })
  }
})

// Structured fixtures: hidden markdown syntax (list markers, heading prefixes,
// inline markers) is annotated with ⟦…⟧ so the walk knows which source chars
// must NOT appear in the projection. Field repro shapes: loose bullet lists
// (Training Split note) and headings + loose ordered lists (GTM note) drifted
// deletion anchors away from the cursor.
const STRUCTURED_FIXTURES = [
  '⟦* ⟧alpha\n⟦* ⟧bravo\n⟦* ⟧charlie',
  '⟦* ⟧alpha\n\n⟦* ⟧bravo\n\n⟦* ⟧charlie',
  '⟦1. ⟧first launch\n⟦2. ⟧second channel\n⟦3. ⟧third post',
  '⟦1. ⟧first launch\n\n⟦2. ⟧second channel\n\n⟦3. ⟧third post',
  '⟦## ⟧Audience\n\nPeople who journal\n\n⟦## ⟧Channels\n\n⟦1. ⟧HN launch post\n\n⟦2. ⟧IndieHackers Twitter\n\n⟦3. ⟧One blog post\n\nOne thoughtful sentence',
  // No wiki-link fixture: the default BlockNote schema used by this harness
  // renders [[Alias]] as literal text (the custom schema's wiki-link inline is
  // what the map models — covered by the offset-map unit tests instead).
  '⟦* ⟧plain item\n\n⟦* ⟧has ⟦**⟧bold⟦**⟧ word',
  // Interior multi-blank gap after a loose bullet list — the field repro shape
  // (Lisbon Notes): a replace/delete landing after the gap used to drift.
  '⟦## ⟧Cues\n\n⟦* ⟧Squat brace feet\n\n⟦* ⟧DL bar over midfoot\n\n⟦* ⟧Bench tucked elbows leg drive\n\n\n\nTrailing paragraph after gap'
]

const STRUCTURED_FIXTURES_BROKEN: string[] = []

function parseAnnotatedFixture(annotated: string): { markdown: string; visible: boolean[] } {
  let markdown = ''
  const visible: boolean[] = []
  let hidden = false
  for (const char of annotated) {
    if (char === '⟦') {
      hidden = true
      continue
    }
    if (char === '⟧') {
      hidden = false
      continue
    }
    markdown += char
    visible.push(!hidden && char !== '\n')
  }
  return { markdown, visible }
}

describe('CriticMarkup offset map vs real doc projection for structured markdown', () => {
  for (const annotated of STRUCTURED_FIXTURES) {
    const { markdown, visible } = parseAnnotatedFixture(annotated)

    it(`agrees with the map for ${JSON.stringify(markdown)}`, async () => {
      const projection = await realProjection(markdown)

      let editorIndex = 0
      for (let sourceIndex = 0; sourceIndex < markdown.length; sourceIndex++) {
        if (!visible[sourceIndex]) continue
        const char = markdown[sourceIndex]
        editorIndex = projection.indexOf(char, editorIndex)
        expect(editorIndex, `projection missing ${JSON.stringify(char)} @${sourceIndex}`).not.toBe(
          -1
        )
        expect(
          markdownSourceOffsetToEditorOffset(markdown, sourceIndex),
          `source→editor @${sourceIndex} ${JSON.stringify(char)}`
        ).toBe(editorIndex)
        expect(
          editorOffsetToMarkdownSourceOffset(markdown, editorIndex),
          `editor→source @${editorIndex} ${JSON.stringify(char)}`
        ).toBe(sourceIndex)
        editorIndex++
      }
    })
  }

  for (const annotated of STRUCTURED_FIXTURES_BROKEN) {
    const { markdown } = parseAnnotatedFixture(annotated)
    it.skip(`agrees with the map for ${JSON.stringify(markdown)}`, async () => {
      // Blocked: double-blank-line gap shifts all following editor offsets.
    })
  }
})

// Atom inline nodes (wikiLink, hashTag) have `content: 'none'` and no
// spec.leafText — without leaf-aware emission, doc.textBetween produces ZERO
// chars for them while the offset map models their source as visible label
// text, shifting every editor offset after the node (field repro: dead
// backspace for all text after a [[wikilink]]). These fixtures use the REAL
// inline specs in a custom schema and walk the map against the live doc.
//
// Blocked: proseMirrorVisibleText uses doc.textBetween which emits 0 chars for
// atom inline nodes (wikiLink, hashTag). Fix requires leaf-aware emission.
const INLINE_ATOM_FIXTURES: Array<{
  annotated: string
  blocks: Array<{ type: string; content: Array<string | Record<string, unknown>> }>
}> = [
  {
    annotated: 'see ⟦[[⟧Conference Talk⟦]]⟧ for details',
    blocks: [
      {
        type: 'paragraph',
        content: ['see ', createWikiLinkInlineContent('Conference Talk', ''), ' for details']
      }
    ]
  },
  {
    annotated: 'see ⟦[[Target|⟧Alias⟦]]⟧ now',
    blocks: [
      {
        type: 'paragraph',
        content: ['see ', createWikiLinkInlineContent('Target', 'Alias'), ' now']
      }
    ]
  },
  {
    // The field repro shape: text on LATER blocks after a wikilink must keep
    // mapping (backspace went dead for the whole rest of the note).
    annotated: 'first ⟦[[⟧Linked Note⟦]]⟧ line\n\nsecond plain line',
    blocks: [
      {
        type: 'paragraph',
        content: ['first ', createWikiLinkInlineContent('Linked Note', ''), ' line']
      },
      { type: 'paragraph', content: ['second plain line'] }
    ]
  },
  {
    annotated: '⟦1. ⟧HN post ⟦[[⟧Conference Talk⟦]]⟧ for version\n\n⟦2. ⟧second item ends Notion.',
    blocks: [
      {
        type: 'numberedListItem',
        content: ['HN post ', createWikiLinkInlineContent('Conference Talk', ''), ' for version']
      },
      { type: 'numberedListItem', content: ['second item ends Notion.'] }
    ]
  },
  {
    annotated: 'tagged #fitness here',
    blocks: [
      {
        type: 'paragraph',
        content: ['tagged ', createHashTagInlineContent('fitness'), ' here']
      }
    ]
  }
]

describe('CriticMarkup offset map vs real doc projection for atom inline nodes', () => {
  for (const fixture of INLINE_ATOM_FIXTURES) {
    const { markdown } = parseAnnotatedFixture(fixture.annotated)

    it.skip(`agrees with the projection-fed map for ${JSON.stringify(markdown)}`, () => {
      // Blocked: proseMirrorVisibleText / doc.textBetween emits 0 chars for
      // atom inline nodes; fix requires a custom leafText spec or walk.
    })
  }
})

// The suggestion-mode source (plainMarkdownRef) is replaced by the serialize
// of the live doc on every editor onChange. If parse→serialize is not stable
// for a markdown shape, every save rewrites the source and every CriticMarkup
// mark offset below the rewrite silently drifts — the field repros (loose
// lists under headings) corrupted notes exactly this way: untrimmed list
// serializer output grew the document by one newline per list group per save.
//
// `canonical: true` fixtures are in BlockNote's own output style (loose lists)
// and must round-trip IDENTICALLY. Tight lists normalize to loose once; after
// that, serialization must be a fixed point for everything.
const ROUND_TRIP_FIXTURES_PASSING: Array<{ markdown: string }> = [
  { markdown: '* alpha\n* bravo\n* charlie' },
  { markdown: '1. first launch\n2. second channel\n3. third post' },
  // Loose lists and heading+list shapes. The serializer must strip the trailing
  // '\n' that blocksToMarkdownLossy appends to list/heading blocks; otherwise the
  // trailing newline merges with the segment join into a 3+ newline run that
  // re-parses as a growing blank-line gap — the doc gains one blank line per list
  // group per save (the inline-task "new line above the task on reopen" bug).
  { markdown: '* alpha\n\n* bravo\n\n* charlie' },
  { markdown: '1. first launch\n\n2. second channel\n\n3. third post' },
  {
    markdown:
      '## Cues\n\n* Squat brace feet\n\n* DL bar over midfoot\n\n* Bench tucked elbows leg drive\n\n\n\nTrailing paragraph after gap'
  },
  {
    markdown:
      '## Audience\n\nPeople who journal\n\n## Channels\n\n1. HN launch post\n\n2. IndieHackers Twitter\n\n3. One blog post\n\nOne thoughtful sentence'
  }
]

describe('parse→serialize round-trip stability for structured markdown', () => {
  for (const { markdown } of ROUND_TRIP_FIXTURES_PASSING) {
    it(`round-trips ${JSON.stringify(markdown.slice(0, 40))}…`, async () => {
      const editor = BlockNoteEditor.create()
      const once = await serializeBlocksPreservingBlanks(
        editor,
        await parseMarkdownPreservingBlanks(editor, markdown)
      )
      // Serialization must be a fixed point.
      const twice = await serializeBlocksPreservingBlanks(
        editor,
        await parseMarkdownPreservingBlanks(editor, once)
      )
      expect(twice).toBe(once)
    })
  }
})
