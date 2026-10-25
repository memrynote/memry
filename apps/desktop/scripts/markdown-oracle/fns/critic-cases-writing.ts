/** Cases of `writing-tools/markdown.ts`. */
import type { OracleCase } from '../cases-frontmatter'
import type { MarkdownSource } from '../cases-bn'
import { parseCriticMarkup } from '../../../../../packages/shared/src/critic-markup/parser'
import {
  decodeWritingMarkers,
  withoutWritingSentinels,
  type WritingFrontmatter
} from '../../../../../packages/shared/src/writing-tools/markdown'
import { fnCase, indexed } from './critic-cases-parse'

const PRIVATE_ALL = Array.from({ length: 0xf8ff - 0xe000 + 1 }, (_, i) =>
  String.fromCharCode(0xe000 + i)
).join('')
const PRIVATE_NO_LAST = PRIVATE_ALL.slice(0, -1)
const PRIVATE_TWO_LEFT = PRIVATE_ALL.slice(0, -2)
const ID64 = 'a'.repeat(64)

export const WRITING_SOURCES: Record<string, string> = {
  empty: '',
  'no markers': 'plain prose, no markers at all',
  alt: 'Sabah <!--alt:k3x9q2-->ayaz<!--/alt:k3x9q2--> bir ruzgar.',
  ghost: 'Kahve <!--ghost-->biraz fazla<!--/ghost--> kalabalikti.',
  'ghost nested': '<!--ghost-->a<!--ghost-->b<!--/ghost-->c<!--/ghost-->',
  'ghost two pairs': '<!--ghost-->a<!--/ghost--> <!--ghost-->b<!--/ghost-->',
  'ghost unpaired open': '<!--ghost-->a<!--ghost-->b<!--/ghost-->',
  'ghost unpaired close': 'a<!--/ghost-->b<!--ghost-->c<!--/ghost-->',
  'alt crossing': '<!--alt:a-->1<!--alt:b-->2<!--/alt:a-->3<!--/alt:b-->',
  'alt nested': '<!--alt:a-->1<!--alt:b-->2<!--/alt:b-->3<!--/alt:a-->',
  'alt duplicate id': '<!--alt:a-->1<!--/alt:a--> <!--alt:a-->2<!--/alt:a-->',
  'alt reopened before close': '<!--alt:a-->1<!--alt:a-->2<!--/alt:a-->3<!--/alt:a-->',
  'alt close first': '<!--/alt:a-->1<!--alt:a-->2',
  'alt only open': 'x <!--alt:a--> y',
  'alt no id': '<!--alt-->x<!--/alt-->',
  'alt id with spaces': '<!-- alt:abc -->x<!-- /alt:abc -->',
  'alt id with slash and spaces': '<!--  /alt:abc  -->',
  'alt id 64': `<!--alt:${ID64}-->x<!--/alt:${ID64}-->`,
  'alt id 65': `<!--alt:${ID64}a-->x<!--/alt:${ID64}a-->`,
  'alt bad id chars': '<!--alt:a.b-->x<!--/alt:a.b-->',
  'alt id dash underscore': '<!--alt:a-_9-->x<!--/alt:a-_9-->',
  'ghost with id': '<!--ghost:abc-->x<!--/ghost:abc-->',
  uppercase: '<!--ALT:a-->x<!--/ALT:a-->',
  'key collision': '<!--alt:g0-->a<!--ghost-->b<!--/ghost-->c<!--/alt:g0-->',
  'key collision reverse': '<!--ghost-->b<!--alt:g0-->a<!--/ghost--><!--/alt:g0-->',
  'js whitespace': '<!--\u00A0alt:a\u00A0-->x<!--\uFEFF/alt:a\u2028-->',
  'not js whitespace': '<!--\u0085alt:a-->x<!--/alt:a-->',
  'other comment': '<!-- a comment --> <!--alt:a--> text',
  'unterminated comment': '<!--alt:a',
  'emoji around': '😀<!--alt:e-->😀 日本語<!--/alt:e-->😀',
  crlf: 'a\r\n<!--ghost-->b\r\n<!--/ghost-->\r\n',
  'taken sentinel': '\uE000<!--alt:a-->x<!--/alt:a-->\uE001',
  'taken many': `${PRIVATE_NO_LAST.slice(0, 500)}<!--alt:a-->x<!--/alt:a-->`,
  'all taken': `${PRIVATE_ALL}<!--alt:a-->x<!--/alt:a-->`,
  'one left': `${PRIVATE_NO_LAST}<!--alt:a-->x<!--/alt:a--><!--ghost-->y<!--/ghost-->`,
  'two left': `${PRIVATE_TWO_LEFT}<!--alt:a-->x<!--/alt:a--><!--ghost-->y<!--/ghost-->`,
  'astral and private': '\u{10000}\uE000<!--ghost-->\u{10FFFF}<!--/ghost-->',
  'inside critic': '{++a <!--alt:a-->b++} c<!--/alt:a-->',
  'critic inside alt': '<!--alt:a-->x {++b++} y<!--/alt:a-->',
  'alt around critic comment': '<!--alt:a-->{==w==}{>>id=c;type=comment | b<<}<!--/alt:a-->',
  'two alts one critic': '<!--alt:a-->{~~p~>q<!--/alt:a--> r~~}<!--alt:b-->s<!--/alt:b-->',
  'emoji critic alt':
    '😀<!--ghost-->😀{++新😀++}<!--/ghost-->{--x--}<!--alt:z-->{~~a~>b~~}<!--/alt:z-->😀'
}

/** Cases for every function that takes decoded text, derived from the real decode and parse. */
function sentinelCases(group: string, slug: string, markdown: string): OracleCase[] {
  const decoded = decodeWritingMarkers(markdown)
  const sentinels = Object.fromEntries(
    [...decoded.sentinels.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1))
  )
  const parsed = parseCriticMarkup(decoded.text)
  const out = [
    fnCase(group, `strip-${slug}`, 'writing.stripWritingSentinels', decoded.text, sentinels),
    fnCase(group, `without-${slug}`, 'writing.withoutWritingSentinels', parsed, sentinels),
    fnCase(group, `encode-plain-${slug}`, 'writing.encodeWritingBody', decoded.text, sentinels, [])
  ]
  if (parsed.marks.length > 0) {
    out.push(
      fnCase(
        group,
        `encode-${slug}`,
        'writing.encodeWritingBody',
        parsed.plainText,
        sentinels,
        withoutWritingSentinels(parsed, decoded.sentinels).marks
      )
    )
  }
  return out
}

const FRONTMATTERS: Record<string, unknown> = {
  null: null,
  string: 'x',
  array: [],
  empty: {},
  'foreign key': { other: 1 },
  'mixed keys': { alternatives: {}, other: 1 },
  'alternatives only': { alternatives: { k1: { versions: ['a', 'b'] } } },
  'overflow only': { overflow: ['x', { text: 'y', label: 'L' }] },
  'alternatives null': { alternatives: null },
  'alternatives array': { alternatives: [] },
  'overflow object': { overflow: {} },
  'overflow null': { overflow: null },
  'full shape': {
    alternatives: {
      k1: {
        original: 'orig',
        versions: ['soguk', { text: 'buz', ai: true }, { text: 'kor', ai: false }]
      },
      k2: ['plain', 'list'],
      'bad id!': { versions: ['x'] },
      k3: { versions: [] },
      k4: { versions: [3, '', { text: '' }, { text: 7 }, null] },
      k5: { original: 5, versions: ['v'] },
      k6: 'string',
      k7: { versions: 'v' }
    },
    overflow: [
      'keep',
      '',
      { text: 'with label', label: 'L' },
      { text: 'empty label', label: '' },
      { text: '', label: 'x' },
      { text: 'numeric label', label: 3 },
      7,
      null
    ]
  },
  'integer-like ids': {
    alternatives: {
      b: { versions: ['b'] },
      '10': { versions: ['10'] },
      '2': { versions: ['2'] },
      '007': { versions: ['007'] },
      a: { versions: ['a'] },
      '4294967295': { versions: ['big'] },
      '4294967294': { versions: ['max'] }
    }
  },
  'empty original': { alternatives: { k: { original: '', versions: ['v'] } } },
  unicode: {
    alternatives: { k: { versions: ['😀', { text: '日本語', ai: true }] } },
    overflow: ['é']
  },
  'ai truthy non boolean': {
    alternatives: {
      k: {
        versions: [
          { text: 'a', ai: 1 },
          { text: 'b', ai: 'true' }
        ]
      }
    }
  }
}

const WRITINGS: Record<string, WritingFrontmatter> = {
  empty: { alternatives: {}, overflow: [] },
  alternatives: {
    alternatives: {
      k1: { versions: [{ text: 'a' }, { text: 'b', ai: true }] },
      k2: { original: 'o', versions: [{ text: 'c', ai: false }] }
    },
    overflow: []
  },
  overflow: {
    alternatives: {},
    overflow: [{ text: 'x' }, { text: 'y', label: 'L' }, { text: 'z', label: '' }]
  },
  'integer ids': {
    alternatives: {
      b: { versions: [{ text: 'b' }] },
      '5': { versions: [{ text: '5' }] },
      '1': { versions: [{ text: '1' }] }
    },
    overflow: []
  }
}

export function writingCases(external: MarkdownSource[]): OracleCase[] {
  const cases: OracleCase[] = []
  indexed(WRITING_SOURCES).forEach(([slug, md]) => {
    cases.push(fnCase('writing-decode', slug, 'writing.decodeWritingMarkers', md))
    cases.push(...sentinelCases('writing-sentinels', slug, md))
  })
  external.forEach((source, i) => {
    const id = `src-${String(i).padStart(4, '0')}`
    cases.push(fnCase('writing-decode-src', id, 'writing.decodeWritingMarkers', source.markdown))
    const cut = source.markdown.indexOf('\n', Math.floor(source.markdown.length / 2))
    const at = cut === -1 ? source.markdown.length : cut
    const spliced = `${source.markdown.slice(0, at)}\n<!--alt:k${i}-->😀 a {++b++}<!--/alt:k${i}--> <!--ghost-->g<!--/ghost-->\n${source.markdown.slice(at)}`
    cases.push(fnCase('writing-decode-mixed', id, 'writing.decodeWritingMarkers', spliced))
  })
  for (const taken of [
    '',
    'abc',
    '\uE000',
    '\uE000\uE001\uE003',
    '😀\uE002',
    PRIVATE_ALL,
    PRIVATE_NO_LAST
  ]) {
    for (const count of [0, 1, 3, 7]) {
      cases.push(
        fnCase(
          'writing-alloc',
          `taken-${taken.length}-${taken.codePointAt(0) ?? 0}-${count}`,
          'writing.createSentinelAllocator',
          taken,
          count
        )
      )
    }
  }
  cases.push(fnCase('writing-alloc', 'exhaust-all', 'writing.createSentinelAllocator', '', 6402))
  for (const [slug, id] of [
    ['empty', ''],
    ['simple', 'k3x9q2xm'],
    ['dash', 'a-b_c'],
    ['64', ID64],
    ['65', `${ID64}a`],
    ['dot', 'a.b'],
    ['space', 'a b'],
    ['newline', 'abc\n'],
    ['non-ascii', 'é'],
    ['fullwidth', 'ａ']
  ] as const) {
    cases.push(fnCase('writing-id', slug, 'writing.isWritingAlternativeId', id))
  }
  Object.entries(FRONTMATTERS).forEach(([name, value], i) => {
    const slug = `${String(i).padStart(3, '0')}-${name.replace(/[^a-z0-9]+/g, '-')}`
    cases.push(
      fnCase('writing-frontmatter', `read-${slug}`, 'writing.readWritingFrontmatter', value)
    )
    cases.push(
      fnCase('writing-frontmatter', `is-${slug}`, 'writing.isWritingFrontmatterValue', value)
    )
    cases.push(
      fnCase('writing-frontmatter', `of-${slug}`, 'writing.writingFrontmatterOf', {
        writing: value
      })
    )
  })
  cases.push(
    fnCase('writing-frontmatter', 'of-null', 'writing.writingFrontmatterOf', null),
    fnCase('writing-frontmatter', 'of-no-key', 'writing.writingFrontmatterOf', { title: 'x' })
  )
  for (const [slug, writing] of Object.entries(WRITINGS)) {
    cases.push(
      fnCase('writing-frontmatter', `to-${slug}`, 'writing.toWritingFrontmatterValue', writing)
    )
  }
  return cases
}
