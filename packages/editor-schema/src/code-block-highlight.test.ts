import { describe, expect, it } from 'vitest'
import { createMemrySchema } from './schema'
import { memryCodeBlockOptions } from './code-block'
import { createServerBlockSpecs, createServerInlineSpecs } from './server'

/**
 * The syntax highlighter asks `meta.highlight` which grammar to load. A fence
 * tag shiki has no grammar for (`memry-portal`, `memry-view`) must answer
 * "none": asking shiki to load it logged a ShikiError on every highlight pass.
 */
describe('which code blocks reach the highlighter', () => {
  const schema = createMemrySchema({
    blocks: createServerBlockSpecs(),
    inline: createServerInlineSpecs(),
    codeBlock: memryCodeBlockOptions
  })
  const highlight = (language: string): string | undefined =>
    schema.blockSpecs.codeBlock.implementation.meta?.highlight?.({
      type: 'codeBlock',
      props: { language }
    } as never)

  it.each(['memry-portal', 'memry-view', 'not-a-language', ''])(
    'renders %j as plain text, without asking shiki for a grammar',
    (language) => {
      expect(highlight(language)).toBeUndefined()
    }
  )

  it.each(['javascript', 'typescript', 'sql', 'shellscript', 'text'])(
    'still highlights %s',
    (language) => {
      expect(highlight(language)).toBe(language)
    }
  )
})
