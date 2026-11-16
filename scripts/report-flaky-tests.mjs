// Posts the tests that passed only on retry in a merge-queue run of rust-ci.yml to the flaky-test
// issue (#3967). Input: a directory of downloaded `nextest-junit-<os>-<n>` artifacts, each holding
// the junit.xml of nextest's `merge-queue` profile (crates/.config/nextest.toml). Logging is best
// effort: every error ends in a warning and exit 0, so the merge queue never fails on it.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const ISSUE = '3967'

const attr = (tag, key) => tag.match(new RegExp(`\\s${key}="([^"]*)"`))?.[1] ?? ''
const unescape = (s) =>
  s.replace(
    /&(lt|gt|quot|apos|amp);/g,
    (_, e) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]
  )

// nextest writes a test that failed and then passed on retry as a <testcase> with one
// <flakyFailure> or <flakyError> per failed attempt. A test that failed every attempt has
// <failure> and <rerunFailure> instead.
export function flakyTests(xml) {
  const flaky = []
  for (const [, open, body = ''] of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  )) {
    const failedAttempts = (body.match(/<flaky(Failure|Error)\b/g) ?? []).length
    if (failedAttempts === 0) continue
    flaky.push({
      name: `${unescape(attr(open, 'classname'))} ${unescape(attr(open, 'name'))}`,
      failedAttempts
    })
  }
  return flaky
}

// Map of test name to the legs it was flaky on, over every artifact directory.
export function collectFlaky(root) {
  const byTest = new Map()
  for (const dir of readdirSync(root).toSorted()) {
    const leg = dir.match(/^nextest-junit-(.+)-\d+$/)?.[1]
    if (!leg) continue
    let xml
    try {
      xml = readFileSync(join(root, dir, 'junit.xml'), 'utf8')
    } catch {
      console.log(`::warning::${dir} has no junit.xml`)
      continue
    }
    for (const { name, failedAttempts } of flakyTests(xml)) {
      const legs = byTest.get(name) ?? []
      legs.push({ leg, failedAttempts })
      byTest.set(name, legs)
    }
  }
  return byTest
}

export const runMarker = (runId) => `<!-- flaky-report run ${runId} -->`

export function commentBody(byTest, { runId, runUrl, pr }) {
  const lines = [...byTest].map(([name, legs]) => {
    const where = legs
      .map(({ leg, failedAttempts }) => `${leg}, failed ${failedAttempts}x before passing`)
      .join('; ')
    return `- \`${name}\` (${where})`
  })
  return [
    runMarker(runId),
    `Flaky in the merge queue (passed on retry) for ${pr ? `#${pr}` : 'an unknown PR'}, run ${runUrl}`,
    '',
    ...lines
  ].join('\n')
}

// gh-readonly-queue/<base>/pr-<number>-<sha>
export const prFromRef = (ref) => ref.match(/\/pr-(\d+)-[0-9a-f]+$/)?.[1] ?? ''

function main() {
  const [root] = process.argv.slice(2)
  const {
    GITHUB_REPOSITORY: repo,
    GITHUB_SERVER_URL: server,
    GITHUB_RUN_ID: runId,
    MERGE_GROUP_REF: ref = ''
  } = process.env
  const byTest = collectFlaky(root)
  if (byTest.size === 0) {
    console.log('No flaky tests.')
    return
  }
  const runUrl = `${server}/${repo}/actions/runs/${runId}`
  const body = commentBody(byTest, { runId, runUrl, pr: prFromRef(ref) })
  console.log(body)
  // A rerun of a job in this run downloads the same artifacts again: post once per run.
  const existing = execFileSync(
    'gh',
    ['api', '--paginate', `repos/${repo}/issues/${ISSUE}/comments`, '--jq', '.[].body'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
  if (existing.includes(runMarker(runId))) {
    console.log(`Run ${runId} is already reported on #${ISSUE}.`)
    return
  }
  const file = join(tmpdir(), `flaky-${runId}.md`)
  writeFileSync(file, body)
  execFileSync('gh', ['issue', 'comment', ISSUE, '--repo', repo, '--body-file', file], {
    stdio: 'inherit'
  })
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.log(`::warning::Could not report flaky tests to #${ISSUE}: ${error.message}`)
  }
}
