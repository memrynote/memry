/**
 * Round-trip conformance for markdown Memry did not author (#1909).
 *
 * Same shape as `blocknote-converter.roundtrip.test.ts`: the pair driven here
 * is the one the app runs — `markdownToYFragment` seeds the doc on note open,
 * `yDocToMarkdown` re-serializes the whole doc on the first write-back after
 * that — and every case pins the exact bytes plus a stable second pass.
 *
 * The corpus is the information-losing subset of the 14 inputs measured on
 * 2026-08-31: a two-space hard line break, a reference-style link with its
 * definition, and an untagged code fence. Each row loses meaning rather than
 * style, which is why these three are fixed and the cosmetic rows are not.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { markdownToYFragment, yDocToMarkdown } from './blocknote-converter'

async function roundTrip(markdown: string): Promise<string> {
  const doc = new Y.Doc()
  const ok = await markdownToYFragment(markdown, doc.getXmlFragment(CRDT_FRAGMENT_NAME))
  expect(ok, 'markdown reached the shared doc').toBe(true)
  const out = await yDocToMarkdown(doc)
  expect(out, 'the doc serialized back at all').not.toBeNull()
  return out as string
}

interface ForeignCase {
  name: string
  markdown: string
  /** Omitted when the bytes must come back exactly as they went in. */
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
    // The fence CHARACTER is still normalized to backticks, which is cosmetic
    // and outside the three information-losing rows this issue fixes. What
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
 * The board the report was written about.
 *
 * The plugin does not read its settings off an AST. `extractSettingsFooter`
 * (`src/parsers/parseMarkdown.ts`) scans the raw file backwards from EOF and
 * `JSON.parse`s everything between the opening fence's third backtick and the
 * closing one, so an info string lands inside the slice: `javascript\n{...}`
 * throws, `StateManager.getParsedBoard` discards the parse, and the board is
 * replaced by a stack trace with every lane and card gone. The two blank lines
 * are harmless — phase one of that scan tolerates ` % \n \r — which is why they
 * are pinned here as canonical rather than chased.
 */
const KANBAN_CASES: ForeignCase[] = [
  {
    name: 'an Obsidian Kanban settings block keeps the bare fence the plugin needs',
    markdown:
      '## Todo\n\n- [ ] card one\n\n%% kanban:settings\n```\n{"kanban-plugin":"basic"}\n```\n%%',
    canonical:
      '## Todo\n\n- [ ] card one\n\n%% kanban:settings\n\n```\n{"kanban-plugin":"basic"}\n```\n\n%%'
  }
]

describe('foreign markdown round-trip, main pipeline', () => {
  const groups: Array<[string, ForeignCase[]]> = [
    ['hard line breaks', HARD_BREAK_CASES],
    ['reference links', REFERENCE_LINK_CASES],
    ['untagged code fences', UNTAGGED_FENCE_CASES],
    ['Obsidian Kanban', KANBAN_CASES]
  ]

  for (const [group, cases] of groups) {
    describe(group, () => {
      it.each(cases)('$name', async ({ markdown, canonical }) => {
        const once = await roundTrip(markdown)
        expect(once, 'round-trip reaches the canonical bytes').toBe(canonical ?? markdown)
        expect(await roundTrip(once), 'second round-trip changes nothing').toBe(once)
      })
    })
  }
})
