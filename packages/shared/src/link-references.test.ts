import { describe, expect, it } from 'vitest'
import {
  restoreLinkReferences,
  stripLinkReferenceDefinitions,
  type LinkReferenceDefinition,
  type LinkReferenceUsage
} from './link-references'

/** What the editor would hand back: every reference resolved to an inline link. */
function inlined(markdown: string, definitions: LinkReferenceDefinition[]): string {
  let out = markdown
  for (const definition of definitions) {
    out = out
      .replace(
        new RegExp(`\\[([^\\]]*)\\]\\[${definition.label}\\]`, 'gi'),
        `[$1](${definition.destination})`
      )
      .replace(new RegExp(`\\[([^\\]]*)\\]\\[\\]`, 'g'), (whole, text: string) =>
        text.toLowerCase() === definition.label ? `[${text}](${definition.destination})` : whole
      )
      .replace(new RegExp(`\\[([^\\]]*)\\](?!\\[|\\()`, 'g'), (whole, text: string) =>
        text.toLowerCase() === definition.label ? `[${text}](${definition.destination})` : whole
      )
  }
  return out
}

function roundTrip(markdown: string): string {
  const stripped = stripLinkReferenceDefinitions(markdown)
  const body = inlined(stripped.markdown, stripped.definitions).replace(/\n+$/, '')
  return restoreLinkReferences(body, stripped.definitions, stripped.usages)
}

describe('stripLinkReferenceDefinitions', () => {
  it('takes the definition out of the body and records the destination', () => {
    const stripped = stripLinkReferenceDefinitions('See [the docs][d].\n\n[d]: https://example.com')

    expect(stripped.markdown).toBe('See [the docs][d].\n')
    expect(stripped.definitions).toHaveLength(1)
    expect(stripped.definitions[0].label).toBe('d')
    expect(stripped.definitions[0].destination).toBe('https://example.com')
    expect(stripped.definitions[0].raw).toBe('[d]: https://example.com')
  })

  it('records one usage per use site, so a definition used twice is not halved', () => {
    const stripped = stripLinkReferenceDefinitions(
      'See [a][d] and [b][d].\n\n[d]: https://example.com'
    )

    expect(stripped.usages.map((usage: LinkReferenceUsage) => usage.raw)).toEqual([
      '[a][d]',
      '[b][d]'
    ])
    expect(stripped.definitions).toHaveLength(1)
  })

  it('reads the collapsed and shortcut forms as references too', () => {
    expect(
      stripLinkReferenceDefinitions('See [docs][].\n\n[docs]: https://example.com').usages[0].raw
    ).toBe('[docs][]')
    expect(
      stripLinkReferenceDefinitions('See [docs].\n\n[docs]: https://example.com').usages[0].raw
    ).toBe('[docs]')
  })

  it('keeps the author whitespace between grouped definitions', () => {
    const stripped = stripLinkReferenceDefinitions('Body.\n\n[a]: /a\n[b]: /b\n\n[c]: /c')

    expect(stripped.definitions.map((d: LinkReferenceDefinition) => d.gapBefore)).toEqual([
      null,
      0,
      1
    ])
  })

  it('leaves a definition-shaped line inside a fence as code', () => {
    const markdown = '```\n[d]: https://example.com\n```'
    expect(stripLinkReferenceDefinitions(markdown)).toEqual({
      markdown,
      definitions: [],
      usages: []
    })
  })

  it('leaves a definition-shaped line in the middle of a paragraph as prose', () => {
    const markdown = 'Some prose\n[d]: https://example.com'
    expect(stripLinkReferenceDefinitions(markdown).definitions).toEqual([])
  })

  it('is not fooled by a footnote definition', () => {
    const markdown = 'Text[^1]\n\n[^1]: The footnote body'
    expect(stripLinkReferenceDefinitions(markdown).definitions).toEqual([])
  })

  it('does not read a wiki link as two shortcut references', () => {
    const stripped = stripLinkReferenceDefinitions('See [[docs]].\n\n[docs]: https://example.com')
    expect(stripped.usages).toEqual([])
  })
})

describe('restoreLinkReferences', () => {
  it('puts a reference link and its definition back exactly as written', () => {
    const markdown = 'See [the docs][d].\n\n[d]: https://example.com'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('restores both use sites of a definition referenced twice', () => {
    const markdown = 'See [a][d] and [b][d].\n\n[d]: https://example.com'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('keeps a definition title the editor never carried', () => {
    const markdown = 'See [the docs][d].\n\n[d]: https://example.com "The docs"'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('leaves an inline link that merely shares a destination alone', () => {
    const markdown = 'See [inline](https://example.com) and [ref][d].\n\n[d]: https://example.com'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('keeps a definition nothing references rather than dropping it', () => {
    const markdown = 'No links here.\n\n[d]: https://example.com'
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it('re-emits a mid-document definition at the end, which CommonMark resolves the same', () => {
    const stripped = stripLinkReferenceDefinitions('Intro.\n\n[d]: /d\n\nSee [x][d].')
    expect(
      restoreLinkReferences('Intro.\n\nSee [x](/d).', stripped.definitions, stripped.usages)
    ).toBe('Intro.\n\nSee [x][d].\n\n[d]: /d')
  })

  it('emits the definitions alone when the body has nothing else left', () => {
    const stripped = stripLinkReferenceDefinitions('[d]: https://example.com')
    expect(restoreLinkReferences('', stripped.definitions, stripped.usages)).toBe(
      '[d]: https://example.com'
    )
  })

  it('is a no-op for a document that had no definitions', () => {
    expect(restoreLinkReferences('Plain body.', [], [])).toBe('Plain body.')
  })

  it('unwraps an angle-bracketed destination the serializer produced', () => {
    const stripped = stripLinkReferenceDefinitions('See [x][d].\n\n[d]: </a path>')
    expect(stripped.definitions[0].destination).toBe('/a path')
    expect(
      restoreLinkReferences('See [x](</a path>).', stripped.definitions, stripped.usages)
    ).toBe('See [x][d].\n\n[d]: </a path>')
  })
})

/**
 * A vault file is input nobody vetted, and both scans here used to be a regex
 * that retried from every position (CodeQL js/polynomial-redos, #1918). At these
 * sizes the old code took 14s and 6s; a bound this loose fails only if the
 * quadratic comes back, not because CI was busy.
 */
describe('adversarial input', () => {
  const BUDGET_MS = 1000

  function elapsed(work: () => void): number {
    const startedAt = performance.now()
    work()
    return performance.now() - startedAt
  }

  it('trims a trailing newline run without walking it once per newline', () => {
    const stripped = stripLinkReferenceDefinitions('[d]: https://example.com')
    const body = `${'\n'.repeat(200_000)}a${'\n'.repeat(3)}`
    let restored = ''

    const ms = elapsed(() => {
      restored = restoreLinkReferences(body, stripped.definitions, stripped.usages)
    })

    expect(restored).toBe(`${'\n'.repeat(200_000)}a\n\n[d]: https://example.com`)
    expect(ms).toBeLessThan(BUDGET_MS)
  })

  it('scans a line of escaped brackets without restarting at each one', () => {
    const noise = `[${'\\[Z'.repeat(60_000)}`
    let stripped: ReturnType<typeof stripLinkReferenceDefinitions> | undefined

    const ms = elapsed(() => {
      stripped = stripLinkReferenceDefinitions(
        `${noise}\n\nSee [the docs][d].\n\n[d]: https://example.com`
      )
    })

    expect(stripped?.usages).toEqual([
      { label: 'd', destination: 'https://example.com', text: 'the docs', raw: '[the docs][d]' }
    ])
    expect(ms).toBeLessThan(BUDGET_MS)
  })
})
