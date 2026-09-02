/**
 * Round-trip conformance for markdown Memry did not author (#1909, #1915).
 *
 * Same shape as `blocknote-converter.roundtrip.test.ts`: the pair driven here
 * is the one the app runs — `markdownToYFragment` seeds the doc on note open,
 * `yDocToMarkdown` re-serializes the whole doc on the first write-back after
 * that — and every case pins the exact bytes plus a stable second pass.
 *
 * Two layers, because the pair has two answers. `roundTrip` is what the app
 * writes: since #1915 the author's bytes ride beside the document and come
 * back for every region the document has not changed, so an untouched note is
 * identity, always. `roundTripCanonical` clears that record and asks what the
 * document alone re-derives, which is what an EDITED region writes and where
 * #1909's three information-losing rows still have to hold.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { Block } from '@blocknote/core'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { writeMarkdownSourceToYDoc } from '@memry/shared/markdown-source'
import {
  MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES,
  blocksToYFragment,
  markdownToYFragment,
  yDocToMarkdown,
  yFragmentToBlocks
} from './blocknote-converter'

async function seed(markdown: string): Promise<Y.Doc> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  return doc
}

async function serialize(doc: Y.Doc): Promise<string> {
  const out = await yDocToMarkdown(doc)
  expect(out, 'the doc serialized back at all').not.toBeNull()
  return out as string
}

/** The pair the app runs. */
async function roundTrip(markdown: string): Promise<string> {
  return serialize(await seed(markdown))
}

/** House style: what an edited region writes. */
async function roundTripCanonical(markdown: string): Promise<string> {
  const doc = await seed(markdown)
  writeMarkdownSourceToYDoc(doc, null)
  return serialize(doc)
}

interface ForeignCase {
  name: string
  markdown: string
  /** House-style bytes when they differ from `markdown`; the app pair is identity regardless. */
  canonical?: string
}

const HARD_BREAK_CASES: ForeignCase[] = [
  { name: 'a two-space hard line break stays a hard line break', markdown: 'Line one  \nLine two' },
  {
    name: 'a hard break between three lines survives on both seams',
    markdown: 'One  \nTwo  \nThree'
  },
  {
    name: 'a hard break next to a soft break keeps both spellings',
    markdown: 'One  \nTwo\nThree'
  },
  {
    name: 'a hard break in the middle of a paragraph run',
    markdown: 'Intro paragraph.\n\nOne  \nTwo\n\nOutro paragraph.'
  },
  { name: 'a soft break is still a soft break', markdown: 'Line one\nLine two' },
  {
    name: 'two spaces inside a fence are content, not a break',
    markdown: '```sh\nline one  \nline two\n```'
  }
]

const REFERENCE_LINK_CASES: ForeignCase[] = [
  {
    name: 'a reference link and its definition both survive',
    markdown: 'See [the docs][d].\n\n[d]: https://example.com'
  },
  {
    name: 'a definition referenced twice is not inlined and deleted',
    markdown: 'See [a][d] and [b][d].\n\n[d]: https://example.com'
  },
  {
    name: 'a collapsed reference keeps its collapsed form',
    markdown: 'See [docs][].\n\n[docs]: https://example.com'
  },
  {
    name: 'a shortcut reference keeps its shortcut form',
    markdown: 'See [docs].\n\n[docs]: https://example.com'
  },
  {
    name: 'several definitions keep their order and their grouping',
    markdown: 'See [one][a] and [two][b].\n\n[a]: https://example.com/a\n[b]: https://example.com/b'
  },
  {
    name: 'a definition with a title keeps the title',
    markdown: 'See [the docs][d].\n\n[d]: https://example.com "The docs"'
  },
  {
    name: 'an inline link sharing a destination with a definition stays inline',
    markdown: 'See [inline](https://example.com) and [ref][d].\n\n[d]: https://example.com'
  },
  {
    name: 'a definition-looking line inside a fence is code, not a definition',
    markdown: '```\n[d]: https://example.com\n```'
  },
  {
    name: 'an unused definition is kept rather than dropped',
    markdown: 'No links here.\n\n[d]: https://example.com'
  },
  {
    // CommonMark resolves a definition wherever it sits, so moving it to the
    // end keeps every link working; what it costs on the house-style path is
    // the author's position. The app pair keeps the position.
    name: 'a mid-file definition comes back at the end without leaving a gap',
    markdown: 'Intro.\n\n[d]: /d\n\nSee [x][d].',
    canonical: 'Intro.\n\nSee [x][d].\n\n[d]: /d'
  }
]

const UNTAGGED_FENCE_CASES: ForeignCase[] = [
  {
    name: 'an untagged fence comes back untagged',
    markdown: 'Run this:\n\n```\nnpm install\n```'
  },
  {
    name: 'a tagged fence keeps its tag',
    markdown: 'Run this:\n\n```sh\nnpm install\n```'
  },
  {
    name: 'an untagged fence next to a tagged one keeps both as written',
    markdown: '```\nplain\n```\n\n```sh\ntagged\n```\n\n```\nplain again\n```'
  },
  {
    // The fence CHARACTER is normalized to backticks on the house-style path,
    // which is cosmetic and outside the three information-losing rows. What
    // matters here is the half that was semantic: no language is invented.
    name: 'an untagged tilde fence comes back untagged',
    markdown: 'Run this:\n\n~~~\nnpm install\n~~~',
    canonical: 'Run this:\n\n```\nnpm install\n```'
  },
  {
    name: 'an untagged fence quoting a shorter fence keeps both',
    markdown: '````\n```\nnested\n```\n````'
  }
]

/**
 * The settings block the report was written about.
 *
 * The plugin does not read its settings off an AST. `extractSettingsFooter`
 * (`src/parsers/parseMarkdown.ts`) scans the raw file backwards from EOF and
 * `JSON.parse`s everything between the opening fence's third backtick and the
 * closing one, so an info string lands inside the slice: `javascript\n{...}`
 * throws, `StateManager.getParsedBoard` discards the parse, and the board is
 * replaced by a stack trace with every lane and card gone. The two blank lines
 * the house-style path injects are harmless — phase one of that scan tolerates
 * ` % \n \r — which is why they are pinned as canonical rather than chased.
 */
const KANBAN_SETTINGS_CASES: ForeignCase[] = [
  {
    name: 'an Obsidian Kanban settings block keeps the bare fence the plugin needs',
    markdown:
      '## Todo\n\n- [ ] card one\n\n%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%',
    canonical:
      '## Todo\n\n- [ ] card one\n\n%% kanban:settings\n\n```\n{"kanban-plugin":"basic"}\n```\n\n%%'
  }
]

/**
 * A whole board, byte for byte as `boardToMd` in the plugin's
 * `src/parsers/formats/list.ts` writes it (frontmatter excluded — the vault
 * layer keeps that outside the body): a `## ` heading per lane, one blank line,
 * `**Complete**` (`completeString`, `src/parsers/common.ts`) on its own line
 * above the cards of a lane that marks them done, `- [x] ` / `- [ ] ` cards,
 * three newlines after each lane, `***` (`archiveString`) then `## Archive`,
 * and `settingsToCodeblock`'s footer: two blank lines, `%% kanban:settings`,
 * a bare fence around the JSON, `%%`.
 *
 * This is a format assertion against the plugin's source, not a live run of
 * the plugin. What can be run is its settings reader, ported verbatim below.
 */
const KANBAN_BOARD = [
  '## Todo',
  '',
  '- [ ] Card one',
  '- [ ] Card two',
  '',
  '',
  '',
  '## Doing',
  '',
  '- [ ] Card three',
  '',
  '',
  '',
  '## Done',
  '',
  '**Complete**',
  '- [x] Card four',
  '',
  '',
  '',
  '***',
  '',
  '## Archive',
  '',
  '- [x] Old card',
  '',
  '',
  '%% kanban:settings',
  '```',
  '{"kanban-plugin":"board","list-collapse":[false,false,false]}',
  '```',
  '%%'
].join('\n')

/** `extractSettingsFooter` from obsidian-kanban `src/parsers/parseMarkdown.ts`, verbatim. */
function extractSettingsFooter(md: string): unknown {
  let hasEntered = false
  let openTickCount = 0
  let settingsEnd = -1

  for (let i = md.length - 1; i >= 0; i--) {
    if (!hasEntered && /[`%\n\r]/.test(md[i])) {
      if (md[i] === '`') {
        openTickCount++

        if (openTickCount === 3) {
          hasEntered = true
          settingsEnd = i - 1
        }
      }
      continue
    } else if (!hasEntered) {
      return {}
    }

    if (md[i] === '`' && md[i - 1] === '`' && md[i - 2] === '`' && /[\r\n]/.test(md[i - 3])) {
      return JSON.parse(md.slice(i + 1, settingsEnd).trim())
    }
  }
  return undefined
}

/** The lane and archive structure the plugin's mdast walk reads. */
function boardShape(md: string): {
  lanes: string[]
  completeLanes: number
  archiveAfterRule: boolean
} {
  const lines = md.split('\n')
  return {
    lanes: lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3)),
    completeLanes: lines.filter((line) => line === '**Complete**').length,
    archiveAfterRule: lines.some(
      (line, index) => line === '## Archive' && lines[index - 2] === '***'
    )
  }
}

// ---------------------------------------------------------------------------
// Half a file edited
// ---------------------------------------------------------------------------

interface HalfEditCase {
  name: string
  markdown: string
  /** Replace the text of the top-level paragraph at this index. */
  paragraph: number
  text: string
  /** The author's spelling everywhere but the edited region, in house style there. */
  expected: string
}

const HALF_EDIT_CASES: HalfEditCase[] = [
  {
    name: 'editing the last paragraph keeps the setext heading, the * list and the glued list',
    markdown: 'Title\n=====\n\nText:\n* One\n* Two\n\n_em_ here.',
    paragraph: 4,
    text: 'Edited here.',
    expected: 'Title\n=====\n\nText:\n* One\n* Two\n\nEdited here.'
  },
  {
    name: 'editing the heading rewrites the whole setext heading and keeps the rest',
    markdown: 'Title\n=====\n\n* One\n* Two',
    paragraph: 0,
    text: 'New title',
    expected: '# New title\n\n* One\n* Two'
  },
  {
    name: 'editing a paragraph above a dash rule keeps the rule as dashes',
    markdown: 'Above\n\n---\n\nBelow',
    paragraph: 0,
    text: 'Above, edited',
    expected: 'Above, edited\n\n---\n\nBelow'
  },
  {
    name: 'editing after a four-space nested list keeps its indent',
    markdown: '- a\n    - b\n\nAfter',
    paragraph: 1,
    text: 'After, edited',
    expected: '- a\n    - b\n\nAfter, edited'
  }
]

async function editParagraph(doc: Y.Doc, index: number, text: string): Promise<void> {
  const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const blocks = (await yFragmentToBlocks(fragment)) as Block[]
  const block = blocks[index] as unknown as { content: unknown }
  block.content = [{ type: 'text', text, styles: {} }]
  doc.transact(() => {
    fragment.delete(0, fragment.length)
    blocksToYFragment(blocks, fragment)
  })
}

describe('foreign markdown round-trip, main pipeline', () => {
  /**
   * The half a byte assertion cannot see. Stripping the definitions before the
   * parse would keep the round trip byte-perfect while the note opens with
   * every reference link as dead bracket text: CommonMark reads `[a][d]` with
   * no definition in sight as literal characters, not a link. The parse must
   * see the definitions so the user gets a working link, and the side-channel
   * is only for the way back out.
   */
  it('a reference link opens as a working link, not bracket text', async () => {
    const doc = await seed('See [the docs][d].\n\n[d]: https://example.com')
    const blocks = await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))
    const inline = (blocks?.[0]?.content ?? []) as Array<{ type: string; href?: string }>
    expect(
      inline.some((part) => part.type === 'link' && part.href === 'https://example.com'),
      'the doc holds a real link with the definition resolved'
    ).toBe(true)
  })

  const groups: Array<[string, ForeignCase[]]> = [
    ['hard line breaks', HARD_BREAK_CASES],
    ['reference links', REFERENCE_LINK_CASES],
    ['untagged code fences', UNTAGGED_FENCE_CASES],
    ['Obsidian Kanban settings', KANBAN_SETTINGS_CASES]
  ]

  for (const [group, cases] of groups) {
    describe(group, () => {
      it.each(cases)('$name (house style)', async ({ markdown, canonical }) => {
        const once = await roundTripCanonical(markdown)
        expect(once, 'round-trip reaches the canonical bytes').toBe(canonical ?? markdown)
        expect(await roundTripCanonical(once), 'second round-trip changes nothing').toBe(once)
      })

      it.each(cases)('$name (untouched, the app pair)', async ({ markdown }) => {
        const once = await roundTrip(markdown)
        expect(once, 'the author’s bytes come back').toBe(markdown)
        expect(await roundTrip(once), 'second round-trip changes nothing').toBe(markdown)
      })
    })
  }

  describe('an Obsidian Kanban board (#1915)', () => {
    it('comes back byte-identical when untouched', async () => {
      const once = await roundTrip(KANBAN_BOARD)
      expect(once).toBe(KANBAN_BOARD)
      expect(await roundTrip(once)).toBe(KANBAN_BOARD)
    })

    it('is still read as the same board by the plugin’s own settings scan and lane shape', async () => {
      const expectedSettings = { 'kanban-plugin': 'board', 'list-collapse': [false, false, false] }
      const expectedShape = {
        lanes: ['Todo', 'Doing', 'Done', 'Archive'],
        completeLanes: 1,
        archiveAfterRule: true
      }
      for (const output of [
        await roundTrip(KANBAN_BOARD),
        await roundTripCanonical(KANBAN_BOARD)
      ]) {
        expect(extractSettingsFooter(output)).toEqual(expectedSettings)
        expect(boardShape(output)).toEqual(expectedShape)
      }
    })

    it('keeps every lane the user did not touch when one card is edited', async () => {
      const doc = await seed(KANBAN_BOARD)
      // Top-level blocks: heading, two cards, gap, gap, heading, card, ... —
      // the third card is `Card three` under Doing.
      const blocks = (await yFragmentToBlocks(doc.getXmlFragment(CRDT_FRAGMENT_NAME))) as Block[]
      const target = blocks.findIndex((block) =>
        JSON.stringify(block.content).includes('Card three')
      )
      expect(target).toBeGreaterThan(-1)
      await editParagraph(doc, target, 'Card three, edited')

      const out = await serialize(doc)
      expect(out).toBe(KANBAN_BOARD.replace('- [ ] Card three', '- [ ] Card three, edited'))
      expect(extractSettingsFooter(out)).toEqual({
        'kanban-plugin': 'board',
        'list-collapse': [false, false, false]
      })
    })
  })

  describe('half a file edited', () => {
    it.each(HALF_EDIT_CASES)('$name', async ({ markdown, paragraph, text, expected }) => {
      const doc = await seed(markdown)
      await editParagraph(doc, paragraph, text)
      const once = await serialize(doc)
      expect(once, 'edited region in house style, the rest as written').toBe(expected)
      expect(await roundTrip(once), 'the merged file is its own fixed point').toBe(once)
    })

    it('an empty trailing paragraph the open editor adds does not cost the author’s bytes', async () => {
      // BlockNote keeps an empty paragraph after the last block while a note
      // is open. It serializes as a trailing gap no file keeps, and it is the
      // shape that made the first E2E of this feature write house style.
      const markdown = 'Title\n=====\n\n* One\n* Two'
      const doc = await seed(markdown)
      const fragment = doc.getXmlFragment(CRDT_FRAGMENT_NAME)
      const blocks = (await yFragmentToBlocks(fragment)) as Block[]
      blocks.push({
        type: 'paragraph',
        id: 'trailing',
        props: {},
        content: [],
        children: []
      } as unknown as Block)
      doc.transact(() => {
        fragment.delete(0, fragment.length)
        blocksToYFragment(blocks, fragment)
      })
      expect(await serialize(doc)).toBe(markdown)
    })

    it('writes house style when the merge would not parse back to the document', async () => {
      // Emptying the only item of a list glued to its paragraph: the merge
      // would splice `Text:` straight onto `-`, one paragraph, and the proof
      // parse refuses it.
      const doc = await seed('Text:\n- Item')
      await editParagraph(doc, 1, '')
      const canonical = await (async () => {
        const copy = new Y.Doc()
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
        writeMarkdownSourceToYDoc(copy, null)
        return serialize(copy)
      })()
      expect(await serialize(doc)).toBe(canonical)
    })
  })

  describe('what an older build sees (#1915 compat)', () => {
    it('a doc with no record serializes exactly as before', async () => {
      const doc = await seed('* One\n* Two')
      writeMarkdownSourceToYDoc(doc, null)
      expect(await serialize(doc)).toBe('- One\n- Two')
    })

    it('a doc carrying CriticMarkup marks keeps house style throughout', async () => {
      // The marks are byte offsets into the serialized text; the author's
      // spelling would move them, so the record is ignored while any exist.
      const doc = await seed('* One\n\nPlain {==marked==} and {>>note<<} with [[A]].')
      expect(doc.getArray('criticMarkupMarks').length, 'the seed found marks').toBeGreaterThan(0)
      const copy = new Y.Doc()
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc))
      writeMarkdownSourceToYDoc(copy, null)
      const houseStyle = await serialize(copy)
      expect(houseStyle.startsWith('- One'), 'house style re-spells the list').toBe(true)
      expect(await serialize(doc)).toBe(houseStyle)
    })

    it('a file already in house style records nothing', async () => {
      const doc = await seed('- One\n- Two')
      expect(doc.getMap('markdownSource').size).toBe(0)
    })
  })

  describe('the sync snapshot budget (#1915)', () => {
    // Foreign prose whose fragment is ~2.9x its bytes (inline marks, nested
    // list), built until the seeded doc plus the source would cross the budget.
    const unit = [
      'Section',
      '=======',
      '',
      'Text:',
      '* One item here',
      '* Two items here',
      '    * Nested item',
      '',
      `${'This is _em_ and __strong__ prose written elsewhere. '.repeat(40)}`,
      '',
      '---',
      ''
    ].join('\n')
    const foreignOf = (bytes: number): string => {
      let out = ''
      while (Buffer.byteLength(out) < bytes) out += unit
      return out.trimEnd()
    }

    it('keeps the record for a note well inside the budget', async () => {
      const markdown = foreignOf(64 * 1024)
      const doc = await seed(markdown)
      const docBytes = Y.encodeStateAsUpdate(doc).byteLength
      expect(docBytes, 'the seeded doc itself is inside the budget').toBeLessThan(
        MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES
      )
      expect(doc.getMap('markdownSource').size).toBe(1)
      expect(await serialize(doc)).toBe(markdown)
    }, 60_000)

    it('records nothing past the budget and round-trips through house style', async () => {
      // Sized off the measured ~2.9x fragment: doc plus source lands past the
      // budget while the file itself is still under the 1 MiB seed ceiling.
      const markdown = foreignOf(Math.ceil(MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES / 3.2))
      const doc = await seed(markdown)
      const docBytes = Y.encodeStateAsUpdate(doc).byteLength
      expect(
        docBytes + Buffer.byteLength(markdown),
        'the case really is past the budget'
      ).toBeGreaterThan(MARKDOWN_SOURCE_SNAPSHOT_BUDGET_BYTES)
      expect(doc.getMap('markdownSource').size).toBe(0)
      const houseStyle = await serialize(doc)
      expect(houseStyle).not.toBe(markdown)
      expect(await roundTripCanonical(markdown)).toBe(houseStyle)
    }, 120_000)
  })
})
