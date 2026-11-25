// Checks the merge-queue quarantine list (crates/.config/quarantine.toml) and prints the nextest filter
// built from it. A quarantined test stops guarding the merge queue, so every entry names a test of the
// main Test step, an issue, an owner and an expiry at most MAX_DAYS away.
//
// No arguments (Rust CI): fails on a structural error; an expired entry is only a warning, because
// --filter already leaves it out and the test guards the queue again.
// --filter (rust-ci.yml's merge-queue Test step): prints the filterset that skips the unexpired entries.
// --online (flake-alarm.yml's daily job): also fails on an expired entry and a closed issue (needs `gh`).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const QUARANTINE = new URL('../crates/.config/quarantine.toml', import.meta.url)
export const MAX_DAYS = 30
// The packages of rust-ci.yml's main Test step (`cargo nextest run --profile "$PROFILE" -p ...`), the
// only step the filter reaches. check-quarantine.test.mjs checks that the two agree.
export const PACKAGES = [
  'memry-core',
  'memry-desktop',
  'memry-media',
  'memry-tauri',
  'memry-test-kit',
  'xtask',
  'memrynote-cli'
]
const FIELDS = ['test', 'issue', 'owner', 'expires']
const ISSUE_URL = /^https:\/\/github\.com\/memrynote\/memry\/issues\/(\d+)$/
// `<binary id> <test name>`, the name nextest prints and writes to JUnit. No filterset syntax inside.
const TEST = /^[\w:.-]+ [\w:.-]+$/
const OWNER = /^@?[A-Za-z0-9][A-Za-z0-9-]{0,38}$/

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
// Valid through its expiry day (UTC).
export const isExpired = ({ expires }, today = new Date()) => expires < day(today)

// Structural errors: Rust CI fails on these. Expiry is separate (expiredEntries).
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
    const pkg = test?.split(/[ :]/)[0]
    if (test && TEST.test(test) && !PACKAGES.includes(pkg))
      errors.push(`${at}: ${pkg} is not run by the merge-queue Test step (${PACKAGES.join(', ')})`)
    if (test && seen.has(test)) errors.push(`${at}: ${test} is listed twice`)
    seen.add(test)
    if (issue && !ISSUE_URL.test(issue))
      errors.push(`${at}: issue must be a memrynote/memry issue URL`)
    if (owner && !OWNER.test(owner)) errors.push(`${at}: owner must be a GitHub login: ${owner}`)
    if (expires) {
      const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(expires) && day(new Date(`${expires}T00:00:00Z`)) === expires
      if (!valid) errors.push(`${at}: expires must be a YYYY-MM-DD date: ${expires}`)
      else if (expires > max)
        errors.push(`${at}: expires ${expires} is more than ${MAX_DAYS} days out (latest ${max})`)
    }
  }
  return errors
}

export const expiredEntries = (entries, today = new Date()) =>
  entries
    .filter((entry) => isExpired(entry, today))
    .map(
      ({ test, issue, expires }) =>
        `${test} expired on ${expires} and runs in the merge queue again; fix it or renew the entry with a reason in ${issue}`
    )

// The filterset for the merge-queue Test step: every test but the unexpired entries.
export function filterset(entries, today = new Date()) {
  const terms = entries
    .filter((entry) => !isExpired(entry, today))
    .map(({ test }) => {
      const [binary, name] = test.split(' ')
      return `(binary_id(=${binary}) & test(=${name}))`
    })
  return terms.length === 0 ? 'all()' : `not (${terms.join(' | ')})`
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
  const expired = expiredEntries(entries)
  if (args.includes('--online')) errors.push(...expired, ...closedIssues(entries))
  // --filter's stdout is the filterset; the checks leg's plain run prints the warnings.
  else if (!args.includes('--filter'))
    for (const message of expired) console.log(`::warning::quarantine: ${message}`)
  for (const error of errors) console.error(`quarantine: ${error}`)
  if (errors.length > 0) process.exit(1)
  if (args.includes('--filter')) console.log(filterset(entries))
  else console.log(`quarantine: ${entries.length} entries OK`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2))
