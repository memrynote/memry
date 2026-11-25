import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  checkFilter,
  filterLine,
  NEXTEST,
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
  test: 'memry-core::integration move_journal::an_open_that_keeps_both_copies_says_so',
  issue: 'https://github.com/memrynote/memry/issues/5900',
  owner: 'h4yfans',
  expires: '2026-12-01'
}
const errorsFor = (text) => {
  const { entries, errors } = parseQuarantine(text)
  return [...errors, ...validate(entries, today)]
}

test('a complete entry passes and leaves the merge queue', () => {
  const text = `# comment\n\n${entry(complete)}  # trailing\n`
  assert.deepEqual(errorsFor(text), [])
  assert.equal(
    filterLine(parseQuarantine(text).entries),
    'default-filter = "not ((binary_id(=memry-core::integration) & test(=move_journal::an_open_that_keeps_both_copies_says_so)))"'
  )
})

test('an empty list runs every test', () => {
  assert.equal(filterLine([]), 'default-filter = "all()"')
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

test('an expired entry, one more than 30 days out and a bad date are refused', () => {
  assert.match(
    errorsFor(entry({ ...complete, expires: '2026-11-19' })).join(),
    /expired on 2026-11-19/
  )
  assert.deepEqual(errorsFor(entry({ ...complete, expires: '2026-11-20' })), [])
  assert.deepEqual(errorsFor(entry({ ...complete, expires: '2026-12-20' })), [])
  assert.match(errorsFor(entry({ ...complete, expires: '2026-12-21' })).join(), /more than 30 days/)
  assert.match(errorsFor(entry({ ...complete, expires: '2026-02-30' })).join(), /YYYY-MM-DD/)
})

test('a malformed test, issue, owner, unknown key, duplicate or stray line is refused', () => {
  const cases = [
    [{ ...complete, test: 'move_journal::x' }, /binary id/],
    [{ ...complete, test: 'a b) | all(' }, /binary id/],
    [{ ...complete, issue: 'https://github.com/other/repo/issues/1' }, /issue URL/],
    [{ ...complete, owner: '<github login>' }, /GitHub login/],
    [{ ...complete, reason: 'x' }, /unknown key reason/]
  ]
  for (const [fields, pattern] of cases) assert.match(errorsFor(entry(fields)).join(), pattern)
  assert.match(errorsFor(`${entry(complete)}\n${entry(complete)}`).join(), /listed twice/)
  assert.match(errorsFor(`test = "x"`).join(), /expected \[\[quarantine\]\]/)
  assert.match(errorsFor(`${entry(complete)}\nexpires = 2026-12-01`).join(), /expected/)
})

test('a nextest filter that does not match the list is refused', () => {
  const { entries } = parseQuarantine(entry(complete))
  assert.match(checkFilter('default-filter = "all()"\n', entries).join(), /--write/)
  assert.deepEqual(checkFilter(`x\n${filterLine(entries)}\n`, entries), [])
})

test("the committed list parses and nextest.toml's merge-queue filter matches it", () => {
  const { entries, errors } = parseQuarantine(readFileSync(QUARANTINE, 'utf8'))
  assert.deepEqual(errors, [])
  assert.deepEqual(checkFilter(readFileSync(NEXTEST, 'utf8'), entries), [])
})
