#!/usr/bin/env node
/**
 * Rejects wall-clock upper bounds in Rust tests: an assert that an elapsed time is below a bound.
 *
 * A loaded runner stretches any measured time, so `assert!(started.elapsed() < SOON)` fails on a
 * busy machine while the code is right, and passes on a fast one while the code waits for a timer
 * it should not. Two merge-queue ejections on 29 Oct came from such asserts, and one of them hid a
 * real scheduler bug. Lower bounds (`elapsed >= DEBOUNCE`) and ordering checks stay allowed: a slow
 * machine only makes them easier to meet.
 *
 * Test code: files under a `tests/` directory, `tests.rs`, `*_test.rs`, `*_tests.rs`, and items
 * behind `#[cfg(test)]` or a `#[test]`-style attribute (modules declared that way pull in their
 * files). A genuine watchdog bound (the call returns before a 30 s timeout it would otherwise hit)
 * takes `// timing-bound: <reason>` in the comment block right above the assert.
 *
 *   node scripts/check-test-timing.mjs [repo root]
 */
import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Anchored to this file, never to the caller's cwd (see check-line-ceilings.mjs). The optional
// argument points the check at another tree; its tests use it.
const repoRoot = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
const ROOTS = ['crates', 'apps/desktop-tauri/src-tauri']
const SKIP_DIRS = new Set(['node_modules', 'target', 'dist', 'Generated', '.git'])
const MIN_REASON = 10
// A poll that gives up at a deadline this long is a timeout guard, not a timing claim; a shorter
// one is what flakes on a loaded runner.
const MIN_POLL_MS = 5000

async function rustFiles(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const found = []
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...(await rustFiles(full)))
    } else if (entry.name.endsWith('.rs')) {
      found.push(full)
    }
  }
  return found
}

const ident = (c) => c !== undefined && /\w/.test(c)

/** The source with comments and string and char literals blanked; offsets and newlines kept. */
function blank(src) {
  const out = src.split('')
  const wipe = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      wipe(i, stop)
      i = stop
    } else if (c === '/' && src[i + 1] === '*') {
      let depth = 1
      let j = i + 2
      while (j < src.length && depth > 0) {
        const pair = src[j] + src[j + 1]
        if (pair === '/*') depth++
        else if (pair === '*/') depth--
        j += pair === '/*' || pair === '*/' ? 2 : 1
      }
      wipe(i, j)
      i = j
    } else if (
      c === 'r' &&
      !ident(src[i - 1] === 'b' ? src[i - 2] : src[i - 1]) &&
      /^r#*"/.test(src.slice(i, i + 260))
    ) {
      const hashes = src.slice(i + 1).match(/^#*/)[0]
      const close = '"' + hashes
      const end = src.indexOf(close, i + 2 + hashes.length)
      const stop = end === -1 ? src.length : end + close.length
      wipe(i, stop)
      i = stop
    } else if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      wipe(i, j + 1)
      i = j + 1
    } else if (c === "'") {
      // A char literal ('x', '\n', '\u{..}'); anything else is a lifetime or label.
      const m = src.slice(i, i + 12).match(/^'(?:\\u\{[0-9A-Fa-f]+\}|\\.|[^\\'\n])'/u)
      if (m) {
        wipe(i, i + m[0].length)
        i += m[0].length
      } else i++
    } else i++
  }
  return out.join('')
}

const OPEN = { '(': ')', '[': ']', '{': '}' }

/** Offset just past the bracket that closes the one at `at`. */
function closeOf(code, at) {
  const stack = []
  for (let j = at; j < code.length; j++) {
    const c = code[j]
    if (OPEN[c]) stack.push(OPEN[c])
    else if (c === ')' || c === ']' || c === '}') {
      stack.pop()
      if (stack.length === 0) return j + 1
    }
  }
  return code.length
}

/**
 * The item after an attribute ending at `from`: [start, end, declaredModule]. An item that reaches
 * `;` before a body at depth 0 is a declaration (`mod x;` names its file).
 */
function itemAfter(code, from) {
  let j = from
  for (;;) {
    while (/\s/.test(code[j] ?? '')) j++
    if (code[j] === '#' && code[j + 1] === '[') j = closeOf(code, j + 1)
    else break
  }
  const start = j
  let depth = 0
  for (; j < code.length; j++) {
    const c = code[j]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (depth === 0 && c === ';') {
      const decl = code.slice(start, j).match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*$/)
      return [start, j + 1, decl?.[1]]
    } else if (depth === 0 && c === '{') return [start, closeOf(code, j), undefined]
  }
  return [start, code.length, undefined]
}

function isTestCfg(attr) {
  const body = attr.replace(/\bnot\s*\([^()]*\)/g, '')
  return /^#\[\s*cfg\s*\(/.test(attr) && /\btest\b/.test(body)
}

/** Test regions of one file, plus the module files its test-only `mod x;` declarations name. */
function testRegions(code, file, wholeFile) {
  const regions = wholeFile ? [[0, code.length]] : []
  const modules = []
  const attr = /#\[\s*(?:cfg\s*\(|(?:\w+::)*test\b)/g
  for (let m; (m = attr.exec(code));) {
    const end = closeOf(code, m.index + 1)
    const text = code.slice(m.index, end)
    if (/^#\[\s*cfg/.test(text) && !isTestCfg(text)) continue
    const [start, stop, mod] = itemAfter(code, end)
    if (!wholeFile) regions.push([m.index, stop])
    if (mod) modules.push(moduleFile(file, mod))
    attr.lastIndex = Math.max(end, start)
  }
  if (wholeFile) {
    for (const m of code.matchAll(/(?:^|[;}\s])(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g))
      modules.push(moduleFile(file, m[1]))
  }
  return { regions, modules: modules.filter(Boolean) }
}

function moduleFile(file, name) {
  const name0 = basename(file)
  const dir = ['mod.rs', 'lib.rs', 'main.rs'].includes(name0)
    ? dirname(file)
    : join(dirname(file), name0.slice(0, -3))
  return [join(dir, `${name}.rs`), join(dir, name, 'mod.rs')].find((p) => existsSync(p))
}

function isTestPath(file) {
  const parts = relative(repoRoot, file).split(sep)
  const name = parts.at(-1)
  return (
    parts.slice(0, -1).includes('tests') ||
    name === 'tests.rs' ||
    name.endsWith('_test.rs') ||
    name.endsWith('_tests.rs')
  )
}

/** Splits an expression into tokens: identifiers and paths, numbers, operators, brackets. */
function tokens(text) {
  const re =
    /\s*((?:[A-Za-z_]\w*)(?:::[A-Za-z_]\w*)*|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?\w*|::<|->|=>|==|!=|<=|>=|&&|\|\||<<|>>|\.\.=?|[^\s])/gy
  const out = []
  for (let m; (m = re.exec(text)) && m[1];) out.push(m[1])
  return out
}

const BOUNDARY = new Set([
  ',',
  '&&',
  '||',
  '==',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '=',
  '=>',
  ';',
  '{',
  '}',
  '|'
])

/** Walks from token `i` in direction `step` to the edge of its operand. */
function operand(toks, i, step) {
  let depth = 0
  const parts = []
  for (let j = i + step; j >= 0 && j < toks.length; j += step) {
    const t = toks[j]
    const opens = step > 0 ? '([' : ')]'
    const closes = step > 0 ? ')]' : '(['
    if (opens.includes(t)) depth++
    else if (closes.includes(t)) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && BOUNDARY.has(t)) break
    else if (depth === 0 && ['if', 'return', 'match', 'let', 'else'].includes(t)) break
    parts.push(t)
  }
  return step > 0 ? parts : parts.toReversed()
}

/** Token indices of comparison operators, skipping turbofish generics `::<..>`. */
function comparisons(toks) {
  const found = []
  for (let i = 0; i < toks.length; i++) {
    if (toks[i] === '::<') {
      let depth = 1
      while (depth > 0 && ++i < toks.length) {
        if (toks[i] === '<' || toks[i] === '::<') depth++
        else if (toks[i] === '>') depth--
        else if (toks[i] === '>>') depth -= 2
      }
    } else if (['<', '<=', '>', '>='].includes(toks[i])) found.push(i)
  }
  return found
}

const NOW = /(?:^|::)Instant::now$/

/** Whether these tokens compute a measured wall-clock duration. */
function measured(toks, vars) {
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    const next = toks[i + 1]
    // `duration_since(UNIX_EPOCH)` is a timestamp, which only an ordering check compares.
    const since =
      /^(?:saturating_|checked_)?duration_since$/.test(t) && !toks[i + 2]?.endsWith('UNIX_EPOCH')
    if ((t === 'elapsed' || since) && toks[i - 1] === '.' && next === '(') return true
    if (/elapsed|latency/i.test(t) || t === 'took') return true
    if (vars.durations.has(t)) return true
    // `Instant::now()` on the small side is "now is before X"; a recorded instant counts only in a
    // subtraction, so `first < second` stays an ordering check.
    if (NOW.test(t)) return true
    if (vars.instants.has(t) && (toks[i - 1] === '-' || toks[i + 1] === '-')) return true
  }
  return false
}

/** Let bindings before `at` in the innermost fn around it: instants and measured durations. */
function bindings(code, fns, at) {
  const fn = fns.filter(([s, e]) => s <= at && at < e).toSorted((a, b) => b[0] - a[0])[0]
  const vars = { instants: new Set(), durations: new Set(), exprs: new Map() }
  if (!fn) return vars
  const body = code.slice(fn[0], at)
  for (const m of body.matchAll(/\blet\s+(?:mut\s+)?(\w+|\([^)]*\))\s*(?::[^=;]*)?=([^;]*);/g)) {
    const names = m[1].match(/\w+/g).filter((n) => n !== 'mut')
    const expr = m[2].trim()
    if (names.length === 1) vars.exprs.set(names[0], tokens(expr))
    const set = /^(?:\w+::)*Instant::now\(\s*\)$/.test(expr)
      ? vars.instants
      : measured(tokens(expr), vars)
        ? vars.durations
        : null
    for (const n of names) set?.add(n)
  }
  return vars
}

function functions(code) {
  const fns = []
  for (const m of code.matchAll(/\bfn\s+\w+/g)) {
    const open = code.indexOf('{', m.index)
    const semi = code.indexOf(';', m.index)
    if (open !== -1 && (semi === -1 || open < semi)) {
      fns.push([open, closeOf(code, open)])
    }
  }
  return fns
}

/** Whether `at` sits inside the body of a `loop`, `while` or `for` of its own function. */
function inLoopBody(code, at) {
  let depth = 0
  for (let j = at - 1; j >= 0; j--) {
    if (code[j] === '}') depth++
    else if (code[j] === '{' && depth-- === 0) {
      depth = 0
      let start = j
      for (let parens = 0; start > 0; start--) {
        const c = code[start - 1]
        if (c === ')' || c === ']') parens++
        else if (c === '(' || c === '[') parens--
        else if (parens === 0 && (c === ';' || c === '{' || c === '}')) break
      }
      const header = code.slice(start, j)
      if (/^\s*(?:'\w+\s*:\s*)?(?:loop|while|for)\b/.test(header)) return true
      if (/\bfn\s+\w+/.test(header)) return false
    }
  }
  return false
}

const UNIT_MS = { from_secs: 1000, from_millis: 1, from_micros: 1e-3, from_nanos: 1e-6 }
UNIT_MS.from_secs_f64 = UNIT_MS.from_secs_f32 = 1000

/**
 * Milliseconds of a duration expression: `Duration::from_*` literals, constants, sums, and
 * products and quotients by a number. NaN when it cannot tell, which leaves the assert flagged.
 */
function durationMs(toks, consts, seen = new Set()) {
  let total = 0
  let term = NaN
  let op = '+'
  const apply = (value) => {
    if (op === '+') {
      total += Number.isNaN(term) ? 0 : term
      term = value
    } else term = op === '*' ? term * value : term / value
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    let value = NaN
    const unit = t.match(/(?:^|::)Duration::(from_\w+)$/)?.[1]
    if (unit && toks[i + 1] === '(') {
      const close = toks.indexOf(')', i)
      value =
        Number(
          toks
            .slice(i + 2, close)
            .join('')
            .replace(/_|f64|f32|u64|u32/g, '')
        ) * UNIT_MS[unit]
      i = close
    } else if (/^\d/.test(t)) value = Number(t.replace(/_|f64|f32|u64|u32|usize/g, ''))
    else if (['+', '*', '/'].includes(t)) {
      op = t
      continue
    } else {
      const name = t.split('::').at(-1)
      if (!consts.has(name) || seen.has(name)) return NaN
      value = durationMs(consts.get(name), consts, new Set([...seen, name]))
    }
    if (op !== '+' && Number.isNaN(term)) return NaN
    apply(value)
  }
  total += term
  return total
}

/**
 * The give-up time of a deadline poll, in ms: `Instant::now() < deadline` where
 * `deadline = Instant::now() + X`, or `started.elapsed() < X`. undefined for any other shape.
 */
function pollDeadlineMs(small, big, vars, consts) {
  const isNow = small.length === 3 && NOW.test(small[0])
  if (isNow && big.length === 1) {
    const expr = vars.exprs.get(big[0])
    if (expr && NOW.test(expr[0]) && expr[1] === '(' && expr[2] === ')' && expr[3] === '+')
      return durationMs(expr.slice(4), consts)
  }
  const isElapsed =
    small.length === 5 && vars.instants.has(small[0]) && small.slice(1).join('') === '.elapsed()'
  if (isElapsed) return durationMs(big, consts)
  return undefined
}

/** `const NAME: Duration = <expr>;` definitions of one file. */
function durationConsts(code) {
  const out = new Map()
  for (const m of code.matchAll(/\bconst\s+(\w+)\s*:\s*(?:\w+::)*Duration\s*=([^;]*);/g))
    out.set(m[1], tokens(m[2]))
  return out
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length

/** The `// timing-bound:` reason in the comment block right above `line`, if any. */
function optOut(lines, line) {
  for (let k = line - 2; k >= 0 && /^\s*\/\//.test(lines[k]); k--) {
    const m = lines[k].match(/\/\/\s*timing-bound:\s*(.*)$/)
    if (m) return m[1].trim()
  }
  return undefined
}

const files = (await Promise.all(ROOTS.map((r) => rustFiles(join(repoRoot, r))))).flat()
if (files.length === 0) {
  console.error(`test timing check found no Rust files under ${ROOTS.join(', ')} of ${repoRoot}`)
  process.exit(1)
}

const sources = new Map()
// Constants a file does not define resolve across the tree (test helpers share `WAIT`); a name
// defined twice takes its shortest value, so an ambiguity can only flag an assert, never pass it.
const sharedConsts = new Map()
for (const file of files) {
  const src = await readFile(file, 'utf8')
  const code = blank(src)
  const consts = durationConsts(code)
  sources.set(file, { src, code, consts })
  for (const [name, toks] of consts)
    (sharedConsts.get(name) ?? sharedConsts.set(name, []).get(name)).push(toks)
}

// Test files by path, then every file a test-only `mod x;` names, transitively.
const testFiles = new Set(files.filter(isTestPath))
const regionsOf = new Map()
const queue = [...files]
while (queue.length > 0) {
  const file = queue.shift()
  const entry = sources.get(file)
  if (!entry) continue
  const { regions, modules } = testRegions(entry.code, file, testFiles.has(file))
  regionsOf.set(file, regions)
  for (const mod of modules) {
    if (testFiles.has(mod)) continue
    testFiles.add(mod)
    queue.push(mod)
  }
}

const violations = []
const optOuts = []
let polls = 0
const ASSERT = /\b(?:debug_)?(?:prop_)?assert\w*\s*!\s*[([{]/g
for (const [file, regions] of regionsOf) {
  const { src, code, consts: own } = sources.get(file)
  const lines = src.split('\n')
  const fns = functions(code)
  const consts = new Map()
  for (const [name, all] of sharedConsts) {
    const ms = all.map((t) => durationMs(t, new Map()))
    consts.set(name, all[ms.indexOf(Math.min(...ms.filter((v) => !Number.isNaN(v))))] ?? all[0])
  }
  for (const [name, toks] of own) consts.set(name, toks)
  const seen = new Set()
  for (const [from, to] of regions) {
    ASSERT.lastIndex = from
    for (let m; (m = ASSERT.exec(code)) && m.index < to;) {
      if (seen.has(m.index)) continue
      seen.add(m.index)
      const open = m.index + m[0].length - 1
      const args = code.slice(open + 1, closeOf(code, open) - 1)
      const toks = tokens(args)
      const vars = bindings(code, fns, m.index)
      const loop = inLoopBody(code, m.index)
      let poll = false
      const hit = comparisons(toks).some((i) => {
        const left = operand(toks, i, -1)
        const right = operand(toks, i, 1)
        const [small, big] = toks[i].startsWith('<') ? [left, right] : [right, left]
        if (!measured(small, vars)) return false
        const ms = loop ? pollDeadlineMs(small, big, vars, consts) : undefined
        if (ms >= MIN_POLL_MS) return !(poll = true)
        return true
      })
      if (!hit) {
        if (poll) polls++
        continue
      }
      const line = lineOf(src, m.index)
      const where = `${relative(repoRoot, file).split(sep).join('/')}:${line}`
      const reason = optOut(lines, line)
      if (reason !== undefined && reason.length >= MIN_REASON) optOuts.push(`${where}: ${reason}`)
      else violations.push(`${where}: ${lines[line - 1].trim()}`)
    }
  }
}

const counted = `${testFiles.size} test files of ${files.length}, ${polls} deadline polls of ${MIN_POLL_MS / 1000} s or more, ${optOuts.length} timing-bound opt-outs`
if (violations.length === 0) {
  console.log(`test timing check passed (${counted})`)
  process.exit(0)
}

console.error(`test timing check failed: ${violations.length} wall-clock upper bounds in tests`)
for (const v of violations.toSorted()) console.error(`- ${v}`)
console.error(
  [
    '',
    'A loaded runner makes an elapsed time arbitrarily long, so this assert flakes, and a fast one',
    "hides the wait it is meant to catch. Drive time through the code's clock or a gate: inject the",
    'clock or a notify the test controls, count what ran, and assert the order of events. A lower',
    `bound (elapsed >= X) is fine, and so is a poll loop that gives up at a deadline of ${MIN_POLL_MS / 1000} s or`,
    'more (a shorter one flakes the same way). A genuine watchdog bound (the call returns before a 30 s timeout',
    'it would otherwise hit) takes `// timing-bound: <reason>` on the line above the assert.'
  ].join('\n')
)
process.exit(1)
