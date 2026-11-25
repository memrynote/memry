// Posts the tests that passed only on retry in a merge-queue run of rust-ci.yml to the flaky-test
// issue (#3967). Input: a directory of downloaded `nextest-junit-<os>-<n>` artifacts, each holding
// the junit.xml of nextest's `merge-queue` profile (crates/.config/nextest.toml). Logging is best
// effort: every error ends in a warning and exit 0, so the merge queue never fails on it.
//
// `--alarm` (flake-alarm.yml) looks at the failed merge-queue runs of the last 24 hours instead. A
// test that failed every retry in the merge groups of two different PRs fails on its runner whatever
// the PR, so it ejects every group until someone acts: it gets an issue labelled `flaky` with a
// quarantine entry ready to paste into crates/.config/quarantine.toml.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
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

// A test that failed every attempt: its <testcase> holds a <failure> or <error>.
export function exhaustedTests(xml) {
  const failed = []
  for (const [, open, body = ''] of xml.matchAll(
    /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g
  )) {
    if (!/<(failure|error)\b/.test(body)) continue
    failed.push(`${unescape(attr(open, 'classname'))} ${unescape(attr(open, 'name'))}`)
  }
  return failed
}

// [leg, junit.xml text] for every `nextest-junit-<leg>-<n>` artifact directory under root.
function* junitFiles(root) {
  for (const dir of readdirSync(root).toSorted()) {
    const leg = dir.match(/^nextest-junit-(.+)-\d+$/)?.[1]
    if (!leg) continue
    try {
      yield [leg, readFileSync(join(root, dir, 'junit.xml'), 'utf8')]
    } catch {
      console.log(`::warning::${dir} has no junit.xml`)
    }
  }
}

// Map of test name to the legs it was flaky on, over every artifact directory.
export function collectFlaky(root) {
  const byTest = new Map()
  for (const [leg, xml] of junitFiles(root)) {
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

// runs: [{ id, url, pr, tests }], the failed merge-queue runs of the window and the tests that failed
// every attempt in each. Returns the tests that did so for two or more PRs, with their runs.
export function repeatOffenders(runs) {
  const byTest = new Map()
  for (const run of runs) {
    if (!run.pr) continue
    for (const test of new Set(run.tests)) byTest.set(test, [...(byTest.get(test) ?? []), run])
  }
  return [...byTest]
    .filter(([, hits]) => new Set(hits.map(({ pr }) => pr)).size >= 2)
    .map(([test, hits]) => ({ test, runs: hits }))
}

export const alarmMarker = (test) => `<!-- flake-alarm ${test} -->`
const alarmRunMarker = (id) => `<!-- flake-alarm run ${id} -->`
const runLine = ({ id, url, pr }) => `- #${pr}: ${url} ${alarmRunMarker(id)}`

// Expires in 14 days: the quarantine checker allows at most 30.
export function quarantineEntry(test, issueUrl, today = new Date()) {
  const expires = new Date(today.getTime() + 14 * 86_400_000).toISOString().slice(0, 10)
  return [
    '[[quarantine]]',
    `test = "${test}"`,
    `issue = "${issueUrl}"`,
    'owner = "<github login>"',
    `expires = "${expires}"`
  ].join('\n')
}

export function alarmBody(test, runs, issueUrl, today = new Date()) {
  return [
    alarmMarker(test),
    `\`${test}\` failed every retry in the merge groups of ${new Set(runs.map(({ pr }) => pr)).size} PRs within 24 hours. Retries cannot save it: it fails on its runner whatever the PR, and ejects each group it runs in.`,
    '',
    ...runs.map(runLine),
    '',
    'Fix it, or quarantine it while it is fixed: paste this into `crates/.config/quarantine.toml`, set the owner, and run `node scripts/check-quarantine.mjs --write`.',
    '',
    '```toml',
    quarantineEntry(test, issueUrl, today),
    '```'
  ].join('\n')
}

const gh = (args, options = {}) =>
  execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })

function withBodyFile(name, body, fn) {
  const file = join(tmpdir(), `${name}.md`)
  writeFileSync(file, body)
  return fn(file)
}

function alarm() {
  const { GITHUB_REPOSITORY: repo } = process.env
  const since = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19)
  const listed = gh([
    'api',
    '--paginate',
    `repos/${repo}/actions/workflows/rust-ci.yml/runs?event=merge_group&status=failure&created=${encodeURIComponent(`>=${since}Z`)}&per_page=100`,
    '--jq',
    '.workflow_runs[] | {id, url: .html_url, branch: .head_branch}'
  ])
  const runs = []
  for (const { id, url, branch } of listed
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))) {
    const dir = mkdtempSync(join(tmpdir(), `junit-${id}-`))
    try {
      gh(
        [
          'run',
          'download',
          String(id),
          '--repo',
          repo,
          '--pattern',
          'nextest-junit-*',
          '--dir',
          dir
        ],
        {
          stdio: 'ignore'
        }
      )
    } catch {
      console.log(`::warning::run ${url} has no nextest JUnit artifacts`)
      continue
    }
    const tests = [...junitFiles(dir)].flatMap(([, xml]) => exhaustedTests(xml))
    runs.push({ id, url, pr: prFromRef(branch), tests })
  }
  const offenders = repeatOffenders(runs)
  if (offenders.length === 0) {
    console.log(`No test failed every retry for two PRs in ${runs.length} failed merge-queue runs.`)
    return
  }
  const open = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--label',
      'flaky',
      '--state',
      'open',
      '--limit',
      '200',
      '--json',
      'number,url,body'
    ])
  )
  for (const { test, runs: hits } of offenders) {
    const issue = open.find(({ body }) => body.includes(alarmMarker(test)))
    if (issue) {
      const seen =
        issue.body +
        gh([
          'api',
          '--paginate',
          `repos/${repo}/issues/${issue.number}/comments`,
          '--jq',
          '.[].body'
        ])
      const fresh = hits.filter(({ id }) => !seen.includes(alarmRunMarker(id)))
      if (fresh.length === 0) continue
      const body = [`\`${test}\` failed every retry again:`, '', ...fresh.map(runLine)].join('\n')
      withBodyFile(`flake-alarm-${issue.number}`, body, (file) =>
        gh(['issue', 'comment', String(issue.number), '--repo', repo, '--body-file', file], {
          stdio: 'inherit'
        })
      )
      continue
    }
    try {
      gh(
        [
          'label',
          'create',
          'flaky',
          '--repo',
          repo,
          '--color',
          'd93f0b',
          '--description',
          'A test that fails on some runs'
        ],
        {
          stdio: 'ignore'
        }
      )
    } catch {
      // The label exists.
    }
    const url = withBodyFile('flake-alarm-new', alarmBody(test, hits, '<this issue>'), (file) =>
      gh([
        'issue',
        'create',
        '--repo',
        repo,
        '--label',
        'flaky',
        '--title',
        `Flaky in the merge queue: ${test}`,
        '--body-file',
        file
      ])
    ).trim()
    withBodyFile('flake-alarm-edit', alarmBody(test, hits, url), (file) =>
      gh(['issue', 'edit', url, '--repo', repo, '--body-file', file], { stdio: 'inherit' })
    )
    console.log(`Opened ${url} for ${test}.`)
  }
}

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

if (import.meta.url === pathToFileURL(process.argv[1]).href && process.argv[2] === '--alarm') {
  alarm()
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.log(`::warning::Could not report flaky tests to #${ISSUE}: ${error.message}`)
  }
}
