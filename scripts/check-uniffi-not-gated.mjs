#!/usr/bin/env node
/**
 * Fails when a UniFFI export sits behind `cfg(feature = "semantic")`.
 *
 * rust-ci.yml's `swift-bindings-fresh` generates the Swift bindings from a
 * library built without `semantic`, and the app links one built with it. An
 * export behind the feature, either polarity, makes the two disagree: Swift
 * misses a function the app ships, or calls one the app lacks (#5247).
 *
 * An export is a `uniffi::` attribute or derive, or a `uniffi::…!` macro.
 * Gated means the cfg sits on the export's item, on an item around it, on an
 * item inside it (a method, a field), or on the module or file that holds it.
 * A cfg inside a function body gates only the implementation and is allowed.
 *
 *   node scripts/check-uniffi-not-gated.mjs [crate-src-dir]
 */
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchored to this file, not the cwd: check-line-ceilings.mjs scanned nothing
// and passed when run from `crates/`.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = resolve(process.argv[2] ?? join(repoRoot, 'crates/memry-core/src'))

const SEMANTIC_CFG = /^#!?\s*\[\s*cfg(?:_attr)?\s*\([\s\S]*\bfeature\s*=\s*"semantic"/
const FULL_ITEM =
  /(?:pub\s*(?:\([^)]*\))?\s*)?(?:(?:unsafe|async|const|default|extern(?:\s*"[^"]*")?)\s+)*(?:fn|struct|enum|union|impl|mod|trait|type|const|static|use|extern|macro_rules!)\b/y

async function rustFiles(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await rustFiles(full)))
    else if (entry.name.endsWith('.rs')) found.push(full)
  }
  return found
}

/** Comments and literal contents blanked, offsets kept, so their brackets do not count. */
function mask(src) {
  const out = src.split('')
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i, i + 2)
    const raw =
      (src[i] === 'r' || src[i] === 'b') && !/\w/.test(src[i - 1] ?? '')
        ? /^b?r(#*)"/.exec(src.slice(i, i + 260))
        : null
    if (rest === '//') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
    } else if (rest === '/*') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        if (src.startsWith('/*', j)) [depth, j] = [depth + 1, j + 2]
        else if (src.startsWith('*/', j)) [depth, j] = [depth - 1, j + 2]
        else j += 1
      }
      blank(i, j)
      i = j
    } else if (raw) {
      const open = i + raw[0].length
      const close = src.indexOf(`"${raw[1]}`, open)
      const stop = close === -1 ? src.length : close
      blank(open, stop)
      i = stop + 1 + raw[1].length
    } else if (src[i] === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = j + 1
    } else if (src[i] === "'" && (src[i + 1] === '\\' || src[i + 2] === "'")) {
      // A char literal; a lifetime (`'a`) has no closing quote.
      const close = src[i + 1] === '\\' ? src.indexOf("'", i + 3) : i + 2
      blank(i + 1, close)
      i = close + 1
    } else i += 1
  }
  return out.join('')
}

const OPEN = '([{'
const CLOSE = ')]}'

function matchForward(code, open) {
  let depth = 0
  for (let j = open; j < code.length; j += 1) {
    if (OPEN.includes(code[j])) depth += 1
    else if (CLOSE.includes(code[j]) && (depth -= 1) === 0) return j
  }
  return code.length - 1
}

/**
 * The item, field, variant or statement that starts at `start`: where it ends,
 * and where its brace body opens (-1 for none).
 */
function extent(code, start) {
  FULL_ITEM.lastIndex = start
  const full = FULL_ITEM.test(code)
  let depth = 0
  for (let j = start; j < code.length; j += 1) {
    const c = code[j]
    if (c === '{' && depth === 0) return { open: j, end: matchForward(code, j) + 1 }
    if (OPEN.includes(c)) depth += 1
    else if (CLOSE.includes(c) && (depth -= 1) < 0) return { open: -1, end: j }
    else if (depth === 0 && (c === ';' || (c === ',' && !full))) return { open: -1, end: j + 1 }
  }
  return { open: -1, end: code.length }
}

/** The block an inner attribute applies to: its enclosing braces, or the file. */
function enclosingBlock(code, at) {
  let depth = 0
  for (let k = at - 1; k >= 0; k -= 1) {
    if (CLOSE.includes(code[k])) depth += 1
    else if (OPEN.includes(code[k]) && (depth -= 1) < 0) return [k, matchForward(code, k) + 1]
  }
  return [0, code.length]
}

/** Every attribute and `uniffi::…!` macro, each with the span it governs. */
function scan(src) {
  const code = mask(src)
  const attrs = []
  for (const m of code.matchAll(/#(!?)\s*\[/g)) {
    const end = matchForward(code, m.index + m[0].length - 1) + 1
    attrs.push({ start: m.index, end, inner: m[1] === '!', text: src.slice(m.index, end) })
  }
  // Attributes in one stack share the item after the last of them.
  for (let a = attrs.length - 1; a >= 0; a -= 1) {
    const attr = attrs[a]
    const next = attrs[a + 1]
    if (attr.inner) [attr.from, attr.to] = enclosingBlock(code, attr.start)
    else if (next && !next.inner && /^\s*$/.test(code.slice(attr.end, next.start))) {
      attr.from = attr.start
      attr.to = next.to
      attr.item = next.item
    } else {
      attr.from = attr.start
      attr.item = code.slice(attr.end).search(/\S/) + attr.end
      attr.to = extent(code, attr.item).end
    }
  }
  const exports = attrs.filter((attr) => /\buniffi::/.test(attr.text))
  for (const m of code.matchAll(/\buniffi::\w+!/g))
    exports.push({ start: m.index, from: m.index, to: m.index + m[0].length, text: m[0] })
  const bodies = [...code.matchAll(/\bfn\s+\w/g)]
    .map((m) => extent(code, m.index))
    .filter(({ open }) => open !== -1)
  const gates = attrs.filter(
    (attr) =>
      SEMANTIC_CFG.test(attr.text) &&
      !bodies.some(({ open, end }) => open < attr.start && attr.start < end)
  )
  return { code, exports, gates }
}

/** `mod name;` declared in `file` resolves to these files and everything under its directory. */
function moduleFiles(file, name, files) {
  const stem = basename(file, '.rs')
  const dir = ['mod', 'lib', 'main'].includes(stem) ? dirname(file) : join(dirname(file), stem)
  const own = join(dir, name)
  const matched = files.filter((f) => f === `${own}.rs` || f.startsWith(`${own}${sep}`))
  return matched.length > 0 ? matched : null
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length
const show = (file) => {
  const path = relative(repoRoot, file)
  return (path.startsWith('..') ? file : path).split(sep).join('/')
}

const files = (await rustFiles(srcRoot)).toSorted()
const scanned = new Map()
for (const file of files) {
  const src = await readFile(file, 'utf8')
  scanned.set(file, { src, ...scan(src) })
}

const violations = []
const gatedFiles = new Map()
for (const [file, { src, code, exports, gates }] of scanned) {
  for (const gate of gates) {
    const where = `${show(file)}:${lineOf(src, gate.start)} ${gate.text.replace(/\s+/g, ' ')}`
    const declared = gate.inner
      ? null
      : /^(?:pub\s*(?:\([^)]*\))?\s*)?mod\s+(\w+)\s*;/.exec(code.slice(gate.item))
    if (declared) {
      const inside = moduleFiles(file, declared[1], files)
      if (!inside)
        violations.push(`${where}: gates \`mod ${declared[1]}\`, whose file this check cannot find`)
      for (const f of inside ?? []) gatedFiles.set(f, where)
    }
    for (const exp of exports)
      if (exp.from < gate.to && gate.from < exp.to)
        violations.push(`${show(file)}:${lineOf(src, exp.start)} ${exp.text} is behind ${where}`)
  }
}
let exportCount = 0
for (const [file, { src, exports }] of scanned) {
  exportCount += exports.length
  const gate = gatedFiles.get(file)
  if (gate)
    for (const exp of exports)
      violations.push(`${show(file)}:${lineOf(src, exp.start)} ${exp.text} is behind ${gate}`)
}

// A check that saw no export proves nothing: the root is wrong.
if (exportCount === 0) {
  console.error(`uniffi gate check found no UniFFI export under ${srcRoot}.`)
  process.exit(1)
}
if (violations.length === 0) {
  console.log(`uniffi gate check passed (${files.length} files, ${exportCount} exports)`)
  process.exit(0)
}
console.error('uniffi gate check failed:')
for (const violation of violations) console.error(`- ${violation}`)
console.error(
  '\nThe Swift bindings are generated without the `semantic` feature and the app links a build ' +
    'with it, so a UniFFI export must not depend on it. Move the export out of the cfg and gate ' +
    'only its implementation.'
)
process.exit(1)
