/* oxlint-disable typescript/no-base-to-string -- linkedom ships no types; Document#toString is its serializer */
// DOM vectors: what linkedom 0.18.12 builds from a page and how its selectors behave on it.
// The Rust port reads the same pages and must reproduce every field.
import { parseHTML } from 'linkedom'

const ELEMENT = 1
const TEXT = 3
const CDATA = 4
const COMMENT = 8
const DOCTYPE = 10

const wellFormed = (value) => String(value).toWellFormed()

/** Joins `[... "\ud835"], ["\udd04" ...]` text nodes, which a Rust string cannot hold apart. */
function mergeSplitSurrogates(nodes) {
  const merged = []
  for (const node of nodes) {
    const last = merged[merged.length - 1]
    if (
      node.t === 'x' &&
      last?.t === 'x' &&
      /[\ud800-\udbff]$/.test(last.d) &&
      /^[\udc00-\udfff]/.test(node.d)
    ) {
      last.d += node.d
    } else {
      merged.push(node)
    }
  }
  return merged.map((node) => (node.t === 'x' ? { t: 'x', d: wellFormed(node.d) } : node))
}

function dump(node) {
  switch (node.nodeType) {
    case ELEMENT:
      return {
        t: 'e',
        n: node.localName,
        svg: 'ownerSVGElement' in node,
        a: [...node.attributes].map((attr) => [attr.name, wellFormed(attr.value)]),
        c: dumpChildren(node)
      }
    case TEXT:
      return { t: 'x', d: node.data }
    case CDATA:
      return { t: 'k', d: wellFormed(node.data) }
    case COMMENT:
      return { t: 'c', d: wellFormed(node.data) }
    case DOCTYPE:
      return { t: 'd', name: node.name, publicId: node.publicId, systemId: node.systemId }
    default:
      throw new Error(`unexpected node type ${node.nodeType}`)
  }
}

function dumpChildren(parent) {
  return mergeSplitSurrogates([...parent.childNodes].map(dump))
}

/** Every element in document order, from the tree and not from linkedom's linked list. */
function elementsOf(root) {
  const out = []
  const visit = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === ELEMENT) {
        out.push(child)
        visit(child)
      }
    }
  }
  visit(root)
  return out
}

function run(fn) {
  try {
    return fn()
  } catch (error) {
    return { error: error.message }
  }
}

function sparse(entries) {
  return Object.fromEntries(
    entries.filter(([, value]) => !(Array.isArray(value) && value.length === 0))
  )
}

export function domVector(fixture, selectors) {
  const { document } = parseHTML(fixture.html)
  const elements = elementsOf(document)
  const ordinalOf = new Map(elements.map((element, index) => [element, index]))
  const listOf = (nodes) => [...nodes].map((node) => ordinalOf.get(node))
  const all = [...selectors.defuddle, ...selectors.probes]
  const probeBase = selectors.defuddle.length

  const documentAll = sparse(
    all.map((selector, index) => [
      String(index),
      run(() => listOf(document.querySelectorAll(selector)))
    ])
  )

  const matching = sparse(
    selectors.probes.map((selector, index) => [
      String(probeBase + index),
      run(() =>
        elements.flatMap((element, ordinal) => (element.matches(selector) ? [ordinal] : []))
      )
    ])
  )
  const sample = elements.flatMap((_, ordinal) => (ordinal % 5 === 0 ? [ordinal] : [])).slice(0, 16)
  const scoped = {}
  const closest = {}
  for (const ordinal of sample) {
    const element = elements[ordinal]
    const scopedHere = sparse(
      selectors.probes.flatMap((selector, index) => {
        const result = run(() => listOf(element.querySelectorAll(selector)))
        return Array.isArray(result) ? [[String(probeBase + index), result]] : []
      })
    )
    const closestHere = Object.fromEntries(
      selectors.probes.flatMap((selector, index) => {
        const found = run(() => element.closest(selector))
        return found && !found.error ? [[String(probeBase + index), ordinalOf.get(found)]] : []
      })
    )
    if (Object.keys(scopedHere).length) scoped[ordinal] = scopedHere
    if (Object.keys(closestHere).length) closest[ordinal] = closestHere
  }

  // `document.head` and `document.body` create elements when they are missing.
  const probe = parseHTML(fixture.html).document
  const headBody = run(() => {
    void probe.head
    void probe.body
    return probe.toString().toWellFormed()
  })

  return {
    html: { sha256: fixture.htmlSha256 },
    document: wellFormed(document.toString()),
    tree: mergeSplitSurrogates([...document.childNodes].map(dump)),
    elementCount: elements.length,
    queries: { document: documentAll, matches: matching, scoped, closest, sample },
    headBody
  }
}

const PIECES = [
  '<p>',
  '</p>',
  '<div>',
  '</div>',
  '<span class="a b">',
  '</span>',
  '<b>',
  '</b>',
  '<i>',
  '</i>',
  '<a href="/x?a=1&b=2">',
  '</a>',
  '<ul>',
  '<li>',
  '</li>',
  '</ul>',
  '<table>',
  '<tr>',
  '<td>',
  '<th>',
  '</td>',
  '</tr>',
  '</table>',
  '<br>',
  '<br/>',
  '<img src=x alt="y">',
  '<hr>',
  '<h1>',
  '</h1>',
  '<h2>',
  '</h3>',
  '<pre>',
  '</pre>',
  '<code>',
  '<script>',
  '</script>',
  '<style>',
  '</style>',
  '<textarea>',
  '</textarea>',
  '<title>',
  '</title>',
  '<select>',
  '<option>',
  '<svg>',
  '</svg>',
  '<math>',
  '<circle r=1/>',
  '<foreignObject>',
  '<template>',
  '</template>',
  '<!-- c -->',
  '<!--',
  '-->',
  '<!DOCTYPE html>',
  '<![CDATA[x]]>',
  '<?pi x?>',
  '<!x>',
  '&amp;',
  '&lt;',
  '&copy',
  '&#65;',
  '&#x1F600;',
  '&#0;',
  '&nosuch;',
  '&',
  'text',
  ' ',
  '\n',
  '\u00e9',
  '\u{1f600}',
  '<',
  '</',
  '<a',
  '<a b',
  '<a b=',
  '<a b="c',
  "<a b='c",
  '<a/',
  '<a /',
  '= ',
  '"',
  "'",
  '>',
  '/',
  '<p class=a class=b>',
  '<P ID=Q>',
  '<input checked>',
  '<dl>',
  '<dt>',
  '<dd>',
  '<form>',
  '<button>',
  '<noscript>',
  '<iframe>',
  '<object>',
  '<param>',
  '<embed>',
  '<tr><td>'
]

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Seeded random token soups with the tree and serialization linkedom builds from each. */
export function fuzzVectors(count) {
  const random = rng(0x5eed3543)
  return Array.from({ length: count }, () => {
    const length = 1 + Math.floor(random() * 24)
    let html = ''
    for (let i = 0; i < length; i += 1) html += PIECES[Math.floor(random() * PIECES.length)]
    const { document } = parseHTML(html)
    return {
      html,
      document: wellFormed(document.toString()),
      tree: mergeSplitSurrogates([...document.childNodes].map(dump))
    }
  })
}
