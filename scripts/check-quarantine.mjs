// Checks the merge-queue quarantine list (crates/.config/quarantine.toml) and keeps the `default-filter`
// of nextest's `merge-queue` profile (crates/.config/nextest.toml) generated from it. A quarantined test
// stops guarding the merge queue, so every entry names a test, an open issue, an owner and an expiry at
// most MAX_DAYS away. `--write` regenerates the filter line; `--online` also fails on a closed issue
// (needs `gh`, run by the flake-alarm workflow's schedule).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const QUARANTINE = new URL('../crates/.config/quarantine.toml', import.meta.url)
export const NEXTEST = new URL('../crates/.config/nextest.toml', import.meta.url)
export const MAX_DAYS = 30
const FIELDS = ['test', 'issue', 'owner', 'expires']
const ISSUE_URL = /^https:\/\/github\.com\/memrynote\/memry\/issues\/(\d+)$/
// `<binary id> <test name>`, the name nextest prints and writes to JUnit. No filterset syntax inside.
const TEST = /^[\w:.-]+ [\w:.-]+$/
const OWNER = /^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
const FILTER_LINE = /^default-filter = .*$/m

// The subset of TOML the list uses: comments, `[[quarantine]]` headers and `key = "string"` lines.
// Anything else is an error rather than a silently dropped entry.
export function parseQuarantine(text) {
  const entries = []
  const errors = []
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) return
    if (line === '[[quarantine]]') {
      entries.push({ line: i + 1 })
      return
    }
    const kv = line.match(/^([a-z]+)\s*=\s*"([^"\\]*)"\s*(#.*)?$/)
    if (!kv || entries.length === 0) {
      errors.push(`line ${i + 1}: expected [[quarantine]] or key = "value", got: ${line}`)
      return
    }
    const entry = entries.at(-1)
    if (kv[1] in entry) errors.push(`line ${i + 1}: duplicate key ${kv[1]}`)
    entry[kv[1]] = kv[2]
  })
  return { entries, errors }
}

const day = (date) => date.toISOString().slice(0, 10)

export function validate(entries, today = new Date()) {
  const errors = []
  const max = day(new Date(today.getTime() + MAX_DAYS * 86_400_000))
  const seen = new Set()
  for (const entry of entries) {
    const at = `entry at line ${entry.line}`
    for (const key of Object.keys(entry)) {
      if (key !== 'line' && !FIELDS.includes(key)) errors.push(`${at}: unknown key ${key}`)
    }
    for (const key of FIELDS) {
      if (!entry[key]) errors.push(`${at}: missing ${key}`)
    }
    const { test, issue, owner, expires } = entry
    if (test && !TEST.test(test))
      errors.push(`${at}: test must be "<binary id> <test name>": ${test}`)
    if (test && seen.has(test)) errors.push(`${at}: ${test} is listed twice`)
    seen.add(test)
    if (issue && !ISSUE_URL.test(issue))
      errors.push(`${at}: issue must be a memrynote/memry issue URL`)
    if (owner && !OWNER.test(owner)) errors.push(`${at}: owner must be a GitHub login: ${owner}`)
    if (expires) {
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(expires) && day(new Date(`${expires}T00:00:00Z`)) === expires
      if (!valid) errors.push(`${at}: expires must be a YYYY-MM-DD date: ${expires}`)
      else if (expires < day(today))
        errors.push(`${at}: expired on ${expires}; fix ${test} or renew with a reason in ${issue}`)
      else if (expires > max)
        errors.push(`${at}: expires ${expires} is more than ${MAX_DAYS} days out (latest ${max})`)
    }
  }
  return errors
}

// The merge-queue profile skips every quarantined test; the default profile (PR, push and scheduled
// runs) still runs them.
export function filterLine(entries) {
  const terms = entries.map(({ test }) => {
    const [binary, name] = test.split(' ')
    return `(binary_id(=${binary}) & test(=${name}))`
  })
  return `default-filter = "${terms.length === 0 ? 'all()' : `not (${terms.join(' | ')})`}"`
}

export function checkFilter(nextest, entries) {
  const want = filterLine(entries)
  const have = nextest.match(FILTER_LINE)?.[0]
  if (have === want) return []
  return [
    `crates/.config/nextest.toml has ${have ?? 'no default-filter'}, want ${want}; run node scripts/check-quarantine.mjs --write`
  ]
}

function closedIssues(entries) {
  return entries.flatMap(({ issue, test }) => {
    const n = issue?.match(ISSUE_URL)?.[1]
    if (!n) return []
    const state = execFileSync(
      'gh',
      ['issue', 'view', n, '--repo', 'memrynote/memry', '--json', 'state', '--jq', '.state'],
      { encoding: 'utf8' }
    ).trim()
    return state === 'OPEN' ? [] : [`${test}: issue ${issue} is ${state}; remove the entry`]
  })
}

function main(args) {
  const { entries, errors } = parseQuarantine(readFileSync(QUARANTINE, 'utf8'))
  errors.push(...validate(entries))
  const nextest = readFileSync(NEXTEST, 'utf8')
  if (args.includes('--write') && errors.length === 0) {
    if (!FILTER_LINE.test(nextest)) throw new Error('nextest.toml has no default-filter line')
    writeFileSync(NEXTEST, nextest.replace(FILTER_LINE, filterLine(entries)))
  } else {
    errors.push(...checkFilter(nextest, entries))
  }
  if (args.includes('--online')) errors.push(...closedIssues(entries))
  for (const error of errors) console.error(`quarantine: ${error}`)
  if (errors.length > 0) process.exit(1)
  console.log(`quarantine: ${entries.length} entries OK`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
