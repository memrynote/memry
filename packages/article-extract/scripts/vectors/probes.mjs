// Unit-level probes of the Defuddle helpers the port reproduces: constants, JSON.parse and
// Number#toString on JSON-LD, URL handling, text helpers, title and author cleaning, date text
// and the schema.org property search. Each expected value is what the TypeScript code returns.
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { findPackage, packageRoot } from './paths.mjs'

export const dist = join(findPackage(packageRoot, 'defuddle'), 'dist')
const require = createRequire(join(dist, 'x.js'))
export const constants = require('./constants.js')
export const { MetadataExtractor } = require('./metadata.js')
export const { countWords, normalizeText } = require('./utils.js')
export const contentBoundary = require('./content-boundary.js')
export const { Defuddle } = require('./defuddle.js')

const attempt = (fn) => {
  try {
    return { ok: fn() }
  } catch (error) {
    return { error: error.constructor.name }
  }
}

/** Every export of constants.js as plain JSON; Sets keep order, RegExps keep source and flags. */
export function constantsVector() {
  const out = {}
  for (const [name, value] of Object.entries(constants)) {
    out[name] =
      value instanceof Set
        ? [...value]
        : value instanceof RegExp
          ? { source: value.source, flags: value.flags }
          : value
  }
  out.MONTH_MAP = MetadataExtractor.MONTH_MAP
  return out
}

const jsonTexts = [
  '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
  '{"b":1,"2":2,"a":3,"1":4,"b":5,"01":6,"4294967295":7,"4294967294":8}',
  '[1e21,1e-7,123456789012345680000,0.1,-0,1E400,-1e-7,5e-324,1.7976931348623157e308,100,1.5e300]',
  '[0.000001,0.0000001,1e20,1e21,123e-20,0.30000000000000004,4.35,0.1e1]',
  '{"s":"\\ud83d\\ude00 \\u00e9 \\n \\t \\u0007 \\" \\\\ \\/"}',
  '"\\u2028\\u2029"',
  '  {"a" : 1 }  ',
  '{"a":1,}',
  "{'a':1}",
  '[1,2',
  '01',
  '1.',
  '.5',
  '+1',
  '-',
  'nul',
  'true false',
  '"abc',
  '"a\tb"',
  '{"__proto__":{"x":1},"y":2}',
  '{"hasOwnProperty":1,"name":"x"}',
  '\u00a01',
  '{"a":{"b":{"c":[[],[{}],{"d":[1,"2",null]}]}}}',
  '[]',
  '{}',
  'null',
  '"just a string"',
  '12345678901234567890',
  '-0.0',
  '[1,2,3,4,5,6,7,8,9,10,11,12]',
  '{"k\\u00e9y":"v","":"empty","1e3":1}'
]

export function jsonProbes() {
  return jsonTexts.map((input) => {
    const result = attempt(() => JSON.stringify(JSON.parse(input)))
    return { input, expected: 'ok' in result ? result.ok : null }
  })
}

const schemaCases = [
  ['[{"author":{"name":"Ann"}}]', 'author.name'],
  ['[{"author":[{"name":"Ann"},{"name":"Bob"},{"name":"Ann"}]}]', 'author.name'],
  ['[{"author":[{"name":"Ann"},{"name":"Bob"}]}]', 'author.[].name'],
  ['[{"author":[{"name":"Ann"},{"name":"Bob"}]}]', 'author.[1].name'],
  ['[{"author":[{"name":"Ann"},{"name":"Bob"}]}]', 'author.[5].name'],
  ['[{"author":[0,{"name":"Bob"}]}]', 'author.[0].name'],
  ['[{"publisher":{"name":"Pub"}},{"name":"x"}]', 'publisher.name'],
  ['[{"publisher":{"@type":"Organization","name":"Pub"}}]', 'publisher'],
  ['[{"x":{"publisher":{"name":"Deep"}}}]', 'publisher.name'],
  ['[{"x":[{"publisher":{"name":"Deep1"}},{"publisher":{"name":"Deep2"}}]}]', 'publisher.name'],
  ['[{"image":["a.png","b.png"]}]', 'image'],
  ['[{"image":[1,2.5,1e21]}]', 'image'],
  ['[{"image":{"url":"u.png"}}]', 'image.url'],
  ['[{"image":[{"url":"u1.png"},{"url":"u2.png"}]}]', 'image.url'],
  ['[{"headline":"H","@graph":[{"headline":"G"}]}]', 'headline'],
  ['[{"name":"top"}]', 'name'],
  ['[{"name":123}]', 'author'],
  ['[{"author":{"name":123}}]', 'author'],
  ['[{"author":{"name":true}}]', 'author'],
  ['[{"author":{"name":{"x":1}}}]', 'author'],
  ['[{"author":{"name":["a","b"]}}]', 'author'],
  ['[{"author":{"name":0}}]', 'author'],
  ['[{"author":"Plain"}]', 'author'],
  ['[{"author":"Plain"}]', 'author.name'],
  ['[{"author":null}]', 'author.name'],
  ['[{"author":{"hasOwnProperty":1,"name":"x"}}]', 'author.name'],
  ['[{"hasOwnProperty":1,"name":"x"}]', 'name'],
  ['[{"datePublished":"2024-01-02"},{"datePublished":"2025-01-02"}]', 'datePublished'],
  ['[{"1":{"a":"one"},"0":{"a":"zero"},"z":{"a":"zed"}}]', 'a'],
  ['[{"mainEntity":{"url":"https://e.com/a"}}]', 'mainEntity.url'],
  ['[]', 'author.name'],
  ['[[{"author":{"name":"Nested"}}]]', 'author.name'],
  ['[{"WebSite":{"name":"W"}}]', 'WebSite.name'],
  ['[{"@type":"WebSite","name":"W"}]', 'WebSite.name'],
  ['[{"a":{"b":"x"},"c":{"a":{"b":"y"}}}]', 'a.b'],
  ['[{"author":[["Nested","List"],{"name":"Bob"}]}]', 'author.name'],
  ['[{"x":"1","y":"1"}]', 'x'],
  ['[{"author":{"name":"A, B"}}]', 'author.name']
]

export function schemaPropertyProbes() {
  return schemaCases.map(([data, property]) => ({
    data,
    property,
    expected: MetadataExtractor.getSchemaProperty(JSON.parse(data), property)
  }))
}

const titles = [
  'Title | Site',
  'Site | Title',
  'Site - Title of the post',
  'Title of the post - Site',
  'Title – Site',
  'Title — Site Name Here',
  'A | B | C',
  'CORS - HTTP | MDN',
  'MDN | Web | CORS | Guide',
  'Big long article title here | Site',
  'Short | Longer segment here',
  'One two three four five | Six',
  'a / b / c d',
  'a · b c d',
  'Hello  |  World again now',
  'No separators at all',
  '  padded title  ',
  'Title | ',
  ' | Site',
  'Çocuk | SİTE',
  'ÇOCUK - Haberler',
  'Title - Site',
  'x - y z',
  'Tom & Jerry (2020) | Site.com',
  'Site.com | Tom & Jerry (2020)',
  'First part - Second part - Third site',
  'The Site: A story - The Site',
  'ΣΑΣ | ΣίΣ',
  'title \u00a0|\u00a0 Site',
  'Rust | The Book | Site',
  'a b c d e f g h | MDN',
  'Home | Site | Blog | Extra',
  'ſite | Title words here',
  'Straße | Title words here'
]
const sites = [
  '',
  'Site',
  'site',
  'SITE',
  'Site Name Here',
  'MDN Web Docs',
  'MDN',
  'The Site',
  'Site.com',
  'Tom & Jerry',
  'Çocuk',
  'çocuk',
  'ΣΑΣ',
  'Sıte',
  'one two three four five six seven',
  'Straße',
  'STRASSE',
  'A | B',
  'a+b',
  '\u00a0'
]

export function cleanTitleProbes() {
  const out = []
  for (const title of titles) {
    for (const site of sites) {
      out.push({ title, site, expected: MetadataExtractor.cleanTitle(title, site) })
    }
  }
  return out
}

const authors = [
  'By Jane Doe',
  'by jane and bob',
  'Jane Doe and Bob Roe',
  'Jane Doe AND Bob Roe',
  'Jane,and Bob',
  'Jane, Bob and Carl',
  'Jane Doe (https://example.com/jane)',
  'Jane Doe https://example.com/jane',
  'Jane Doe ( https://example.com/jane )',
  'Jane (HTTP://X.COM) Doe',
  'https://example.com',
  'Jane http://',
  'Jane Doe - ',
  'Jane Doe | ',
  'Jane Doe —',
  'Jane Doe – Staff Writer',
  '  By  Jane  ',
  'By',
  'bybob',
  'Andrew and\u00a0Sandy',
  'Jane\nand\nBob',
  'a and and b',
  'Jane Doe,',
  'Jane\u2003Doe | \u3000'
]

export function cleanAuthorProbes() {
  return authors.map((input) => ({ input, expected: MetadataExtractor.cleanAuthorString(input) }))
}

const dateTexts = [
  '26 February 2025',
  'Wednesday, 26 February 2025',
  'February 26, 2025',
  'February 26 2025',
  'june 5, 2023',
  'Posted on 1 MARCH 2024 by me',
  '1 March 24',
  '123 March 2024',
  '1 March 20245',
  'Feb 26, 2025',
  '26 Sept 2025',
  'May 5,   2020',
  'May\u00a05, 2020',
  'x15 May 2020',
  '15 May 2020x',
  '15 May 2020 and 3 June 2021',
  'Published May 5, 2020 or 6 June 2021',
  '2025-02-26',
  'tomorrow',
  '',
  '\u0661 March 2024',
  '5\u2003March\u20032024',
  '5 \u017fune 2024'
]

export function dateTextProbes() {
  return dateTexts.map((input) => ({ input, expected: MetadataExtractor.parseDateText(input) }))
}

const textSamples = [
  '',
  '  ',
  'one two  three',
  'one\ttwo\nthree',
  '日本語のテキスト and English',
  '한국어 문장입니다',
  'a\u00a0b',
  'a\u2003b',
  'a\u200bb',
  '\u201cQuoted\u201d \u2014 text\u2026  here',
  '\u2018single\u2019 \u201Alow\u201B \u2012\u2013\u2015 \u201E\u201F',
  'MiXeD CaSe İSTANBUL',
  'a\u{1f600}b c',
  '\u0000a\u0001b \u0020c',
  'Σίσυφος ΑΣ'
]

export function textProbes() {
  return textSamples.map((input) => ({
    input,
    countWords: countWords(input),
    normalizeText: normalizeText(input)
  }))
}

const urlPairs = [
  [null, 'https://www.example.com/a/b?c=d#e'],
  [null, 'https://WWW.Example.COM:8080/x'],
  [null, 'http://example.com'],
  [null, 'example.com/page'],
  [null, '//example.com/x'],
  [null, 'mailto:a@b.c'],
  [null, 'file:///tmp/x'],
  [null, 'https://bücher.example/straße'],
  [null, 'https://[::1]:3000/x'],
  [null, 'https://user:pw@host.example/p'],
  [null, 'HTTPS://EXAMPLE.COM/A%20B'],
  [null, 'https://example.com./x'],
  [null, 'https://exa mple.com/'],
  [null, 'https://192.168.0.1/x'],
  [null, 'https://0x7f.1/x'],
  [null, 'data:text/plain,hi'],
  [null, ''],
  ['https://example.com/a/b/c', '/favicon.ico'],
  ['https://example.com/a/b/c', '../d'],
  ['https://example.com/a/b/c/', 'd/e'],
  ['https://example.com/a/b?q=1', '?r=2'],
  ['https://example.com/a/b', '#frag'],
  ['https://example.com/a/b', 'https://other.example/x'],
  ['https://example.com/a/b', '//cdn.example/x'],
  ['https://example.com/a/b', 'javascript:alert(1)'],
  ['https://example.com/a/b', 'x y'],
  ['https://example.com/a//b/../c/./d', 'e'],
  ['https://example.com', 'foo'],
  ['https://example.com/a/b/', '/post/'],
  ['https://example.com/a/b/', '/post///'],
  ['https://example.com:443/a', '/b'],
  ['http://example.com:80/a', '/b'],
  ['https://example.com/ä', 'ö'],
  ['https://example.com/a b', 'c d'],
  ['about:blank', '/x'],
  ['mailto:a@b.c', '/x']
]

export function urlProbes() {
  return urlPairs.map(([base, input]) => {
    const parse = () => {
      const url = base === null ? new URL(input) : new URL(input, base)
      return {
        href: url.href,
        hostname: url.hostname,
        origin: url.origin,
        pathname: url.pathname
      }
    }
    const result = attempt(parse)
    return { base, input, expected: 'ok' in result ? result.ok : null }
  })
}

/** The partial-selector regexes against selectors, near-misses and what real pages carry. */
export function partialProbes(extraTexts) {
  const patterns = constants.PARTIAL_SELECTORS
  const probes = new Set(extraTexts)
  for (const pattern of patterns) {
    probes.add(pattern)
    probes.add(pattern.toUpperCase())
    probes.add(`x-${pattern}-y`)
    probes.add(`main-${pattern}`)
    probes.add(`h2-${pattern}`)
    probes.add(`${pattern}${pattern}`)
  }
  for (const text of [
    'main-access-wall',
    'main-access-wall access-wall',
    'xmain-access-wall',
    'MAIN-ACCESS-WALL',
    'h1-related',
    'H6-RELATED',
    'h7-related',
    'h1-related related',
    'prefix_related',
    'cookie law',
    'cookie\nlaw',
    'cookie\u2028law',
    'cookie\u2022law',
    'COOKIE.LAW',
    'hero-',
    'heroes',
    'hero1',
    'hero_',
    'HERO-x',
    'a-comment',
    'a-comment b',
    'a-commented',
    'nocontent',
    'a nocontent b',
    '_nocontent_',
    'anocontent',
    '\u017fponsor',
    'sponsor\u017f',
    'tic\u212aer',
    '-ticker',
    '\u0130dvert',
    'ADVERT',
    'Advert',
    'sidebar-content',
    '',
    'theroleofthings',
    'loopsandfeedback',
    'TheRoleOfThings'
  ]) {
    probes.add(text)
  }
  return [...probes].map((text) => ({
    text,
    partial: constants.PARTIAL_SELECTORS_REGEX.test(text),
    anchored: constants.PARTIAL_SELECTORS_ANCHORED_REGEX.test(text)
  }))
}

const captures = (match) => (match ? Array.from(match, (group) => group ?? null) : null)

/** The Tailwind class patterns against names `standardize` meets in SVG class lists. */
export function tailwindProbes() {
  return [
    'fill-red-500',
    'stroke-slate-50',
    'fill-blue-500/50',
    'fill-red-5',
    'fill-red-5000',
    'fill-black',
    'stroke-current',
    'fill-White',
    'fill-Red-500',
    'text-[#fff]',
    'text-[rgb(1,2,3)]',
    'text-[]',
    'text-[a\nb]',
    'text-[a\u2028b]',
    'text-[x]y',
    'text-[x][y]',
    'fill-red-\u0665\u0660\u0660',
    'fill-red-500\n',
    ''
  ].map((text) => ({
    text,
    color: captures(constants.TW_COLOR_CLASS_RE.exec(text)),
    special: captures(constants.TW_SPECIAL_CLASS_RE.exec(text)),
    arbitrary: captures(constants.TW_ARBITRARY_RE.exec(text))
  }))
}
