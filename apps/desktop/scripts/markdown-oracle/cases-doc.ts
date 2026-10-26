/**
 * Inputs of the Y.Doc vector files of stage 6 (#3522): `seed-doc.json`,
 * `roundtrip.json`, `blocks.json`, `serialize-doc.json` and `replace-body.json`.
 * Expected outputs come from the oracle (`doc-oracle.ts`); nothing here states
 * an answer.
 */
import * as Y from 'yjs'

import type { MarkdownSource } from './cases-bn'
import type { OracleCase } from './cases-frontmatter'
import { memryParseCases } from './cases-parse'
import { yxmlCases } from './cases-pm'
import type { DocEdit } from './doc-oracle'

/** `group/old-op/slug` of a parse case, as `group/new-op/slug`. */
function reid(parse: OracleCase, group: string, op: string): string {
  const slug = parse.id.split('/').slice(2).join('-')
  return `${group}/${op}/${slug}`
}

function hasLetter(markdown: unknown): boolean {
  return typeof markdown === 'string' && /[a-z]{2}/i.test(markdown)
}

/** Bodies the editor spells differently than the author did, so a source record is kept. */
const FOREIGN: Record<string, string> = {
  'star-bullets': '* One\n* Two\n\nafter\n',
  'underscore-emphasis': 'a _em_ and __strong__ here\n',
  'setext-heading': 'Title\n=====\n\nbody text\n',
  'rule-variants': 'one\n\n---\n\ntwo\n\n___\n\nthree\n',
  'four-space-nesting': '- a\n    - b\n        - c\n\ntail\n',
  'list-glued': 'intro\n- x\n- y\n',
  'html-comment': 'before\n\n<!-- keep me -->\n\nafter text\n',
  'crlf-body': 'one\r\ntwo\r\n\r\nthree\r\n',
  'trailing-spaces': 'trailing  \nbreak\n',
  'numbered-style': '1) first\n2) second\n\nafter\n',
  'table-loose': '| a | b |\n|---|---|\n| 1 | 2 |\n\ntext after\n',
  'task-line': '- [ ] todo item\n- [x] done item\n\nmore words\n'
}

/** Writing tools notes: alternatives in both states, ghosts, ranges across blocks and marks. */
const WRITING: Record<string, { markdown: string; writing?: unknown }> = {
  'alt-shown': {
    markdown: 'one <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n',
    writing: {
      alternatives: { k3x9q2: { versions: [{ text: 'two' }, { text: 'zwei', ai: true }] } },
      overflow: [{ text: 'spare', label: 'L' }, { text: 'second' }]
    }
  },
  'alt-original': {
    markdown: 'one <!--alt:k3x9q2-->zwei<!--/alt:k3x9q2--> three\n',
    writing: {
      alternatives: {
        k3x9q2: { original: 'two', versions: [{ text: 'two' }, { text: 'zwei' }] }
      },
      overflow: []
    }
  },
  ghost: {
    markdown: 'a <!--ghost-->ghosted<!--/ghost--> b\n',
    writing: { alternatives: {}, overflow: [] }
  },
  'two-ghosts': {
    markdown: '<!--ghost-->a<!--/ghost--> and <!--ghost-->b<!--/ghost-->\n',
    writing: { alternatives: {}, overflow: [] }
  },
  'alt-across-blocks': {
    markdown: '<!--alt:abc-->first\n\nsecond<!--/alt:abc-->\n',
    writing: { alternatives: { abc: { versions: [{ text: 'x' }] } }, overflow: [] }
  },
  'alt-in-bold': {
    markdown: 'x **<!--alt:b1-->bold<!--/alt:b1-->** y\n',
    writing: { alternatives: { b1: { versions: [{ text: 'strong' }] } }, overflow: [] }
  },
  'alt-nested': {
    markdown: '<!--alt:o1-->out <!--alt:i1-->in<!--/alt:i1--> side<!--/alt:o1-->\n',
    writing: {
      alternatives: { o1: { versions: [{ text: 'a' }] }, i1: { versions: [{ text: 'b' }] } },
      overflow: []
    }
  },
  'alt-unicode': {
    markdown: 'caf\u00e9 <!--alt:u1-->na\u00efve \ud83d\ude00 x<!--/alt:u1--> end\n',
    writing: { alternatives: { u1: { versions: [{ text: 'x' }] } }, overflow: [] }
  },
  'markers-only': { markdown: 'p <!--alt:zz-->q<!--/alt:zz-->\n' },
  'unpaired-marker': {
    markdown: 'p <!--alt:zz-->q\n',
    writing: { alternatives: { zz: { versions: [{ text: 'x' }] } }, overflow: [] }
  },
  'alt-with-critic': {
    markdown: 'a {++<!--alt:k1-->new<!--/alt:k1-->++} b\n',
    writing: { alternatives: { k1: { versions: [{ text: 'n' }] } }, overflow: [] }
  },
  // Regressions found by the differential run (#3522 stage 7): a range that
  // ends after a multi-byte character, and one that ends on an astral one.
  'ghost-after-two-byte-char': {
    markdown: '<!--ghost-->a<!--/ghost-é-> and <!--ghost-->b<!--/ghost-->'
  },
  'ghost-after-three-byte-char': {
    markdown: '<!--ghost-->a <!--alt:q1-->b<!--/alt:q1--\u200b> c<!--/ghost-->',
    writing: { alternatives: { q1: { versions: [{ text: 'x' }] } }, overflow: [] }
  },
  'ghost-ends-on-astral-char': { markdown: 'é <!--ghost-->go 😀<!--/ghost--> after\n' },
  'alt-after-non-ascii': {
    markdown: 'é日本 <!--alt:k1-->ayaz<!--/alt:k1--> bir 😀 ruzgar.\n',
    writing: { alternatives: { k1: { versions: [{ text: 'n' }] } }, overflow: [] }
  },
  'overflow-only': {
    markdown: 'plain\n',
    writing: { alternatives: {}, overflow: [{ text: 'kept', label: 'tag' }] }
  }
}

export function parseInputs(external: MarkdownSource[]): OracleCase[] {
  // The parse list's own `writing-alt` note carries versions as bare strings,
  // which the seed's writing frontmatter reader (`{text}`) never meets.
  const cases = memryParseCases(external).filter((c) => !c.id.endsWith('/writing-alt'))
  for (const [name, input] of Object.entries(WRITING)) {
    cases.push({ id: `parse-writing/memry-parse/${name}`, op: 'memry-parse', input })
  }
  return cases
}

export function seedDocCases(external: MarkdownSource[]): OracleCase[] {
  return parseInputs(external).map((c) => ({
    id: reid(c, 'seed-doc', 'doc-seed'),
    op: 'doc-seed',
    input: c.input
  }))
}

export function roundtripCases(external: MarkdownSource[]): OracleCase[] {
  return parseInputs(external).map((c) => ({
    id: reid(c, 'roundtrip', 'doc-serialize'),
    op: 'doc-serialize',
    input: c.input
  }))
}

export function blocksCases(external: MarkdownSource[]): OracleCase[] {
  const cases: OracleCase[] = parseInputs(external).map((c) => ({
    id: reid(c, 'blocks', 'doc-blocks'),
    op: 'doc-blocks',
    input: c.input
  }))
  for (const hex of yxmlCases().filter((c) => c.op === 'yxml-read')) {
    cases.push({
      id: `blocks-hex/doc-blocks/${hex.id.split('/')[2]}`,
      op: 'doc-blocks',
      input: hex.input
    })
  }
  return cases
}

function brokenIds(): string {
  const doc = new Y.Doc()
  doc.clientID = 0x6d656d72
  const group = new Y.XmlElement('blockGroup')
  const one = new Y.XmlElement('blockContainer')
  one.setAttribute('id', '')
  const paragraph = new Y.XmlElement('paragraph')
  const text = new Y.XmlText()
  text.insert(0, 'x')
  paragraph.insert(0, [text])
  one.insert(0, [paragraph])
  const two = new Y.XmlElement('blockContainer')
  const second = new Y.XmlElement('paragraph')
  two.insert(0, [second])
  const columns = new Y.XmlElement('columnList')
  columns.setAttribute('id', 'keep')
  group.insert(0, [one, two, columns])
  doc.getXmlFragment('prosemirror').insert(0, [group])
  return Buffer.from(Y.encodeStateAsUpdate(doc)).toString('hex')
}

function edit(kind: 'insert-start' | 'insert-end', text: string): DocEdit {
  return { kind, run: 0, text }
}

export function serializeDocCases(external: MarkdownSource[]): OracleCase[] {
  const cases: OracleCase[] = []
  // Documents authored from Yjs trees: the real note-blocks documents and the
  // hand cases, including the fail-closed ones.
  for (const hex of yxmlCases().filter((c) => c.op === 'yxml-read')) {
    cases.push({
      id: `serialize-hex/doc-serialize/${hex.id.split('/')[2]}`,
      op: 'doc-serialize',
      input: hex.input
    })
  }
  cases.push({
    id: 'serialize-repair/doc-repair-ids/empty-ids',
    op: 'doc-repair-ids',
    input: { updateHex: brokenIds(), fragment: 'prosemirror' }
  })
  // A seeded document edited before it is read: the merge, with every kind of
  // edit near a re-spelled construct.
  const parse = parseInputs(external).filter((c) => hasLetter(c.input.markdown))
  parse.forEach((c, index) => {
    const slug = c.id.split('/').slice(2).join('-')
    if (index % 4 === 0) {
      cases.push({
        id: `serialize-edit/doc-serialize/start-${slug}`,
        op: 'doc-serialize',
        input: { ...c.input, edits: [edit('insert-start', 'EDIT ')] }
      })
    }
    if (index % 4 === 2) {
      cases.push({
        id: `serialize-edit/doc-serialize/end-${slug}`,
        op: 'doc-serialize',
        input: { ...c.input, edits: [edit('insert-end', ' tail')] }
      })
    }
  })
  // Foreign spellings, with the edits and file bodies that decide the outcome.
  for (const [name, markdown] of Object.entries(FOREIGN)) {
    const base = { markdown }
    cases.push({ id: `serialize-foreign/doc-serialize/${name}`, op: 'doc-serialize', input: base })
    cases.push({
      id: `serialize-foreign/doc-serialize/${name}-edit-end`,
      op: 'doc-serialize',
      input: { ...base, edits: [edit('insert-end', ' more')] }
    })
    cases.push({
      id: `serialize-foreign/doc-serialize/${name}-edit-start`,
      op: 'doc-serialize',
      input: { ...base, edits: [edit('insert-start', 'New ')] }
    })
    cases.push({
      id: `serialize-foreign/doc-serialize/${name}-no-record`,
      op: 'doc-serialize',
      input: { ...base, edits: [{ kind: 'clear-source' }] }
    })
    cases.push({
      id: `serialize-foreign/doc-serialize/${name}-old-record`,
      op: 'doc-serialize',
      input: { ...base, edits: [{ kind: 'set-source', source: markdown, htmlComments: false }] }
    })
    // A record that no longer describes the document: the file stands in.
    const stale: DocEdit[] = [
      { kind: 'set-source', source: 'unrelated text\n', htmlComments: true },
      edit('insert-end', ' x')
    ]
    for (const [label, fileBody] of [
      ['file-same', markdown],
      ['file-missing', null],
      ['file-throws', 'throw'],
      ['file-changed', `${markdown}\nextra line\n`]
    ] as const) {
      cases.push({
        id: `serialize-foreign/doc-serialize/${name}-${label}`,
        op: 'doc-serialize',
        input: { ...base, edits: stale, fileBody }
      })
    }
    cases.push({
      id: `serialize-foreign/doc-serialize/${name}-emptied`,
      op: 'doc-serialize',
      input: { ...base, edits: [{ kind: 'delete-fragment' }] }
    })
  }
  return cases
}

export function replaceBodyCases(): OracleCase[] {
  const bases: Record<string, string> = {
    'one-paragraph': 'old body\n',
    'foreign-list': '* a\n* b\n',
    'with-writing': 'text <!--alt:k3x9q2-->shown<!--/alt--> end\n',
    empty: ''
  }
  const next: Record<string, { markdown: string; extra?: Record<string, unknown> }> = {
    'new-paragraph': { markdown: 'new body\n' },
    'foreign-spelling': { markdown: '* x\n* y\n\n_em_ text\n' },
    'empty-markdown': { markdown: '' },
    'blank-only': { markdown: '\n\n' },
    'critic-marks': { markdown: 'a {++added++} b {--gone--} c\n' },
    'link-references': { markdown: 'see [docs][d]\n\n[d]: https://example.com/docs\n' },
    'writing-markers': {
      markdown: 'one <!--alt:k3x9q2-->two<!--/alt:k3x9q2--> three\n',
      extra: {
        writing: {
          alternatives: { k3x9q2: { versions: [{ text: 'two' }, { text: 'zwei' }] } },
          overflow: [{ text: 'spare' }]
        }
      }
    },
    'large-file': { markdown: `${'word '.repeat(30000)}\n` },
    'toggle-and-columns': {
      markdown:
        '<details>\n<summary>T</summary>\n\nbody\n\n</details>\n\n--- start-multi-column: x\n\nL\n\n--- end-column ---\n\nR\n\n--- end-multi-column\n'
    }
  }
  const cases: OracleCase[] = []
  for (const [baseName, baseMarkdown] of Object.entries(bases)) {
    for (const [name, spec] of Object.entries(next)) {
      cases.push({
        id: `replace/doc-replace/${baseName}-to-${name}`,
        op: 'doc-replace',
        input: { baseMarkdown, markdown: spec.markdown, ...spec.extra }
      })
    }
    cases.push({
      id: `replace/doc-replace/${baseName}-guard-match`,
      op: 'doc-replace',
      input: { baseMarkdown, markdown: 'guarded body\n', unlessChanged: true }
    })
    cases.push({
      id: `replace/doc-replace/${baseName}-guard-stale`,
      op: 'doc-replace',
      input: { baseMarkdown, markdown: 'guarded body\n', unlessChanged: false }
    })
  }
  return cases
}
