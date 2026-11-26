import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  expiredEntries,
  filterset,
  PACKAGES,
  parseQuarantine,
  QUARANTINE,
  validate
} from './check-quarantine.mjs'

const today = new Date('2026-11-20T12:00:00Z')
const entry = (fields) =>
  ['[[quarantine]]', ...Object.entries(fields).map(([key, value]) => `${key} = "${value}"`)].join(
    '\n'
  )
const complete = {
  test: 'memry-desktop::integration move_journal::an_open_that_keeps_both_copies_says_so',
  issue: 'https://github.com/memrynote/memry/issues/5900',
  owner: 'h4yfans',
  expires: '2026-12-01'
}
const errorsFor = (text) => {
  const { entries, errors } = parseQuarantine(text)
  return [...errors, ...validate(entries, today)]
}

test('a complete entry passes and the merge-queue filter skips it', () => {
  const text = `# comment\n\n${entry(complete)}  # trailing\n`
  assert.deepEqual(errorsFor(text), [])
  assert.equal(
    filterset(parseQuarantine(text).entries, today),
    'not ((binary_id(=memry-desktop::integration) & test(=move_journal::an_open_that_keeps_both_copies_says_so)))'
  )
})

test('an empty list runs every test', () => {
  assert.equal(filterset([], today), 'all()')
})

test('an expired entry is no longer skipped and is reported, but is not a structural error', () => {
  const { entries } = parseQuarantine(
    `${entry({ ...complete, expires: '2026-11-19' })}\n${entry({ ...complete, test: 'memry-core a::b', expires: '2026-11-20' })}`
  )
  assert.deepEqual(validate(entries, today), [])
  assert.equal(filterset(entries, today), 'not ((binary_id(=memry-core) & test(=a::b)))')
  assert.equal(expiredEntries(entries, today).length, 1)
  assert.match(
    expiredEntries(entries, today)[0],
    /expired on 2026-11-19 and runs in the merge queue again/
  )
})

test('an entry without an issue, owner or expiry is refused', () => {
  for (const key of ['test', 'issue', 'owner', 'expires']) {
    const { [key]: _, ...rest } = complete
    assert.ok(
      errorsFor(entry(rest)).some((e) => e.endsWith(`missing ${key}`)),
      `missing ${key}`
    )
  }
})

test('an expiry more than 30 days out or a bad date is refused', () => {
  assert.deepEqual(errorsFor(entry({ ...complete, expires: '2026-12-20' })), [])
  assert.match(errorsFor(entry({ ...complete, expires: '2026-12-21' })).join(), /more than 30 days/)
  assert.match(errorsFor(entry({ ...complete, expires: '2026-02-30' })).join(), /YYYY-MM-DD/)
})

test('a malformed test, issue, owner, unknown key, duplicate or stray line is refused', () => {
  const cases = [
    [{ ...complete, test: 'move_journal::x' }, /binary id/],
    [{ ...complete, test: 'a b) | all(' }, /binary id/],
    [
      { ...complete, test: 'memry-ml::lane a::b' },
      /memry-ml is not run by the merge-queue Test step/
    ],
    [{ ...complete, issue: 'https://github.com/other/repo/issues/1' }, /issue URL/],
    [{ ...complete, owner: '<github login>' }, /GitHub login/],
    [{ ...complete, reason: 'x' }, /unknown key reason/]
  ]
  for (const [fields, pattern] of cases) assert.match(errorsFor(entry(fields)).join(), pattern)
  assert.match(errorsFor(`${entry(complete)}\n${entry(complete)}`).join(), /listed twice/)
  assert.match(errorsFor(`test = "x"`).join(), /expected \[\[quarantine\]\]/)
  assert.match(errorsFor(`${entry(complete)}\nexpires = 2026-12-01`).join(), /expected/)
})

test("the packages match rust-ci.yml's suite, and every merge-queue run of it applies the filter", () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/rust-ci.yml', import.meta.url),
    'utf8'
  )
  // The suite is built by test-archive (`cargo nextest archive`) and, on macOS, by lint-and-test's
  // Test step; test-partitions runs the archive.
  const builds = [
    ...workflow.matchAll(
      /^ {10}cargo nextest (?:run|archive) (-p .*--features memry-core\/markdown.*)$/gm
    )
  ].map(([, args]) => args)
  assert.equal(builds.length, 2, 'test-archive and the macOS Test step build the suite')
  for (const args of builds)
    assert.deepEqual(
      [...args.matchAll(/-p (\S+)/g)].map(([, p]) => p),
      PACKAGES
    )
  const runs = [
    ...workflow.matchAll(
      /^ {10}(cargo(?:-nextest)? nextest run .*\$\{FILTER:\+-E "\$FILTER"\}.*)$/gm
    )
  ]
  assert.equal(runs.length, 2, 'test-partitions and the macOS Test step apply the filter')
  const sets = [
    ...workflow.matchAll(
      /if \[ "\$NEXTEST_PROFILE" = merge-queue \]; then FILTER=\$\(node \.\.\/scripts\/check-quarantine\.mjs --filter\); fi/g
    )
  ]
  assert.equal(sets.length, 2)
})

test('the committed list parses', () => {
  const { errors } = parseQuarantine(readFileSync(QUARANTINE, 'utf8'))
  assert.deepEqual(errors, [])
})
