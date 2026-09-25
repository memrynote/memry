/**
 * Desktop's half of the `markdown-seed` vector class (spec 005-journal
 * JP022a).
 *
 * The generator (`packages/contracts/scripts/vectors/markdown-seed.ts`)
 * cannot import this app, so it rebuilds `markdownToYFragment`'s path from the
 * packages that path uses. This suite is what makes the committed file
 * desktop's: every case is run through the real `markdownToYFragment` and its
 * fragment must render to the committed canonical form, block ids removed.
 */
import { readFileSync } from 'node:fs'

import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { canonicalFragment } from '../../../../../packages/contracts/scripts/fragment-canonical'
import { markdownToYFragment } from './blocknote-converter'

interface MarkdownSeedCase {
  name: string
  markdown: string
  expectedCanonical: string
}

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../../packages/contracts/test-vectors/markdown-seed.json', import.meta.url),
    'utf8'
  )
) as { cases: MarkdownSeedCase[] }

const withoutBlockIds = (canonical: string): string =>
  canonical.replace(/^(\d+ element blockContainer) id="[^"]*"/gm, '$1')

describe('markdown-seed vectors', () => {
  it.each(vectors.cases.map((entry) => [entry.name, entry] as const))(
    '%s is what markdownToYFragment builds',
    async (_name, entry) => {
      const doc = new Y.Doc()
      expect(await markdownToYFragment(entry.markdown, doc.getXmlFragment('prosemirror'))).toBe(
        true
      )
      expect(withoutBlockIds(canonicalFragment(doc))).toBe(entry.expectedCanonical)
    }
  )
})
