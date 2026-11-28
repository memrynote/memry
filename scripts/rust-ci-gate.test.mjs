import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

// Main's ruleset requires `Rust CI gate` (#5221), and so does feat/tauri-v2's merge queue (#3517). A
// required check that never reports blocks the PR forever, and a skipped one counts as passed, so the
// gate must report on every PR, fail when a needed job failed, and on a PR that changes a Rust CI
// path pass only when the Rust legs ran and passed.
const repo = new URL('..', import.meta.url).pathname
const pathsAction = join(repo, '.github/actions/paths-changed')
const listFilter = readFileSync(join(pathsAction, 'action.yml'), 'utf8').match(/--jq '([^']+)'/)[1]
const workflow = readFileSync(join(repo, '.github/workflows/rust-ci.yml'), 'utf8')
// The plan job's `Detect changed paths` step is the first include in the file.
const include = workflow.match(/include: '([^']+)'/)[1]
const pushPaths = [
  ...workflow
    .match(/^ {2}push:\n[\s\S]*?^ {4}paths:\n((?: {6}(?:- '.*'|#.*)\n)+)/m)[1]
    .matchAll(/^ {6}- '(.*)'$/gm)
].map((m) => m[1])
const jobs = workflow.slice(workflow.indexOf('\njobs:\n'))
const gateStart = jobs.indexOf('\n  gate:\n')
const gateEnd = jobs.slice(gateStart + 1).search(/\n {2}[a-z0-9-]+:\n/)
const gate = jobs.slice(gateStart, gateEnd === -1 ? undefined : gateStart + 1 + gateEnd)
// A `labeled` or `opened` event that only feat/tauri-v2's `full-ci` tiering acts on runs no job (the
// concurrency group names it); every other run is a real one.
const noop = workflow.match(/^ {2}group: rust-ci-.*?\$\{\{ (\(\(.*?\)\)\)) && format\('-noop-/m)[1]
// Not gate dependencies, each for the reason rust-ci.yml gives: the iOS unit plan (intermittent tests
// on the shared macOS pool), the flaky-test report (logging a flake never ejects a PR) and the
// scheduled-failure report (it needs the gate).
const notGated = ['ios-unit-tests', 'flaky-report', 'report']

// `files` are paths, or `{ filename, previous_filename }` for a rename. They go through the files
// API's entry shape and the action's own jq filter, as the action lists them.
function changed(files) {
  const page = files.map((file) =>
    typeof file === 'string'
      ? { filename: file, status: 'modified' }
      : { status: 'renamed', ...file }
  )
  const listed = spawnSync('jq', ['-c', listFilter], {
    input: JSON.stringify(page),
    encoding: 'utf8'
  })
  assert.equal(listed.status, 0, listed.stderr)
  const result = spawnSync('bash', [join(pathsAction, 'changed.sh')], {
    input: listed.stdout,
    env: { PATH: process.env.PATH, INCLUDE: include, EXCLUDE: '^$' },
    encoding: 'utf8'
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function runGate(env) {
  const script = gate.match(/ {8}run: \|\n((?: {10}.*\n|\n)+)/)[1].replace(/^ {10}/gm, '')
  return spawnSync('bash', ['-c', script], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8'
  }).status
}

describe('Rust CI gate', () => {
  it('runs on every pull request and merge group', () => {
    const pullRequest = workflow.match(/^ {2}pull_request:\n((?: {4}.*\n)*)/m)[1]
    assert.doesNotMatch(pullRequest, /^ {4}(paths|paths-ignore|branches|branches-ignore):/m)
    const types = pullRequest.match(/^ {4}types: \[([^\]]+)\]/m)
    if (types) {
      for (const type of ['opened', 'synchronize', 'reopened'])
        assert.ok(types[1].split(/,\s*/).includes(type), type)
    }
    assert.match(workflow, /^ {2}merge_group:\n/m)
    assert.match(gate, /^ {4}name: Rust CI gate\n/m)
    // Skipped only in a noop run into feat/tauri-v2: PRs into main, pushes and the merge queue all
    // see it report.
    assert.equal(
      gate.match(/^ {4}if: (.*)$/m)[1],
      `\${{ always() && !(${noop} && github.base_ref != 'main') }}`
    )
    assert.equal(gate.match(/^ {10}MIRROR: \$\{\{ (.*) \}\}$/m)[1], noop)
  })

  it('runs the Rust jobs for every file the push filter lists, and none for a docs-only PR', () => {
    for (const path of pushPaths)
      assert.equal(changed([path.replace('**', 'x/y.rs').replace('*', '')]), 'true', path)
    for (const [, action] of workflow.matchAll(/uses: \.\/\.github\/actions\/([a-z0-9-]+)/g))
      assert.ok(pushPaths.includes(`.github/actions/${action}/**`), action)
    // The flaky report and the quarantine check run inside Rust CI's merge-queue legs.
    for (const script of ['report-flaky-tests', 'check-quarantine'])
      for (const file of [`scripts/${script}.mjs`, `scripts/${script}.test.mjs`])
        assert.equal(changed([file]), 'true', file)
    assert.equal(changed(['apps/docs/src/contribute/testing.md', 'README.md']), 'false')
  })

  it('runs the Rust jobs for a rename out of crates/', () => {
    const moved = { filename: 'docs/old-lib.rs', previous_filename: 'crates/memry-core/src/lib.rs' }
    assert.equal(changed([moved]), 'true')
    assert.equal(changed([{ ...moved, previous_filename: 'apps/docs/old-lib.rs' }]), 'false')
  })

  it('runs the Rust jobs for a list of 3000 files, where the API stops', () => {
    const docs = Array.from({ length: 3000 }, (_, i) => `apps/docs/src/generated/page-${i}.md`)
    assert.equal(changed(docs), 'true')
    assert.equal(changed(docs.slice(1)), 'false')
  })

  it('needs every other job but the ones it leaves out on purpose', () => {
    const ids = [...jobs.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map((m) => m[1])
    for (const id of notGated) assert.ok(ids.includes(id), id)
    const needs = gate
      .match(/needs:\s*\[([^\]]+)\]/)[1]
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
    assert.deepEqual(
      needs.toSorted(),
      ids.filter((id) => id !== 'gate' && !notGated.includes(id)).toSorted()
    )
  })

  it('fails on a failed job, and on a PR that changes a Rust CI path unless the Rust legs passed', () => {
    // RESULTS follows gate.needs: plan, lint-and-test, test-archive, test-partitions, the ml-worker,
    // the article vectors and the Swift bindings. RUST_RESULTS: the three Rust leg jobs.
    assert.match(
      gate,
      /^ {10}RUST_RESULTS: \$\{\{ needs\.lint-and-test\.result \}\} \$\{\{ needs\.test-archive\.result \}\} \$\{\{ needs\.test-partitions\.result \}\}$/m
    )
    const pr = { DETECT_RESULT: 'success', EVENT: 'pull_request', CHANGED: 'true' }
    const rustPassed = 'success success success'
    const rustSkipped = 'skipped skipped skipped'
    const passed = 'success success success success success success success'
    const skipped = 'success skipped skipped skipped skipped skipped skipped'
    assert.equal(
      runGate({ ...pr, CHANGED: 'false', RUST_RESULTS: rustSkipped, RESULTS: skipped }),
      0
    )
    assert.equal(runGate({ ...pr, RUST_RESULTS: rustPassed, RESULTS: passed }), 0)
    // The tier skips the legs a diff cannot break.
    const tiered = 'success success success success skipped skipped success'
    assert.equal(runGate({ ...pr, RUST_RESULTS: rustPassed, RESULTS: tiered }), 0)
    // A push the merge queue already passed skips the Rust legs.
    const covered = { ...pr, EVENT: 'push', RUST_RESULTS: rustSkipped, RESULTS: skipped }
    assert.equal(runGate(covered), 0)
    assert.equal(runGate({ ...pr, RUST_RESULTS: rustSkipped, RESULTS: skipped }), 1)
    // A merge group that changes a Rust CI path runs every Rust leg, so a skip is no pass.
    const queued = { ...pr, EVENT: 'merge_group' }
    assert.equal(runGate({ ...queued, RUST_RESULTS: rustSkipped, RESULTS: skipped }), 1)
    assert.equal(
      runGate({ ...queued, RUST_RESULTS: 'success success skipped', RESULTS: skipped }),
      1
    )
    assert.equal(runGate({ ...queued, RUST_RESULTS: rustPassed, RESULTS: passed }), 0)
    for (const [rust, results] of [
      ['failure success success', 'success failure success success success success success'],
      ['cancelled success success', 'success cancelled success success success success success'],
      // A failed archive build skips its partitions; a failed or cancelled partition fails the gate.
      ['success failure skipped', 'success success failure skipped success success success'],
      ['success success failure', 'success success success failure success success success'],
      ['success success cancelled', 'success success success cancelled success success success'],
      [rustPassed, 'success success success success success success failure']
    ]) {
      assert.equal(runGate({ ...pr, RUST_RESULTS: rust, RESULTS: results }), 1, results)
      assert.equal(
        runGate({ ...pr, EVENT: 'merge_group', RUST_RESULTS: rust, RESULTS: results }),
        1
      )
    }
    // A pull request whose Rust legs passed but whose partitions never ran is no pass.
    const noPartitions = 'success success success skipped success success success'
    assert.equal(
      runGate({ ...pr, RUST_RESULTS: 'success success skipped', RESULTS: noPartitions }),
      1
    )
    const noPlan = 'failure skipped skipped skipped skipped skipped skipped'
    assert.equal(
      runGate({
        ...pr,
        DETECT_RESULT: 'failure',
        CHANGED: '',
        RUST_RESULTS: rustSkipped,
        RESULTS: noPlan
      }),
      1
    )
    assert.equal(runGate({ ...pr, CHANGED: '', RUST_RESULTS: rustSkipped, RESULTS: skipped }), 1)
  })

  // Each test partition used to build the whole workspace (about 12 minutes of a windows-2022
  // partition). test-archive builds the suite once per OS and test-partitions runs the archive.
  describe('the nextest archive', () => {
    const job = (id) => {
      const start = jobs.indexOf(`\n  ${id}:\n`)
      assert.ok(start !== -1, id)
      const end = jobs.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/)
      return jobs.slice(start, end === -1 ? undefined : start + 1 + end)
    }
    const archive = job('test-archive')
    const partitions = job('test-partitions')
    const lintAndTest = job('lint-and-test')
    // The suite's packages and features, from a `cargo nextest <verb> ...` line.
    const suite = (line) =>
      line
        .match(/((?: -p \S+)+) .*?(--features \S+)/)
        .slice(1)
        .join(' ')

    it('builds the same suite the macOS legs run', () => {
      const built = archive.match(/^ {10}cargo nextest archive (.*)$/m)?.[1]
      assert.ok(built, 'test-archive runs cargo nextest archive')
      const macos = lintAndTest.match(
        /^ {10}cargo nextest run (-p .*\$\{FILTER:\+-E "\$FILTER"\})$/m
      )
      assert.ok(macos, "lint-and-test's Test step runs the suite")
      assert.equal(suite(` ${built}`), suite(` ${macos[1]}`))
      assert.match(suite(` ${built}`), /--features memry-core\/markdown$/)
      assert.match(built, /--archive-file "\$RUNNER_TEMP\/nextest-archive\.tar\.zst"/)
      assert.match(
        archive,
        /name: nextest-archive-\$\{\{ matrix\.os \}\}\n {10}path: \$\{\{ runner\.temp \}\}\/nextest-archive\.tar\.zst\n/
      )
      // A merge group runs no partition of the suite in lint-and-test.
      assert.doesNotMatch(lintAndTest, /--partition/)
    })

    it('runs every partition from the archive of its OS, with no build', () => {
      assert.match(partitions, /^ {4}needs: \[plan, test-archive\]$/m)
      assert.match(
        partitions,
        /name: nextest-archive-\$\{\{ matrix\.os \}\}\n {10}path: \$\{\{ runner\.temp \}\}\/nextest-archive\n/
      )
      const runs = [...partitions.matchAll(/^ {10}(cargo nextest .*)$/gm)].map((m) => m[1])
      assert.deepEqual(runs, [
        'cargo nextest run --archive-file "$RUNNER_TEMP/nextest-archive/nextest-archive.tar.zst" --workspace-remap . --extract-to . --extract-overwrite --no-fail-fast --partition "slice:$PARTITION" ${FILTER:+-E "$FILTER"}'
      ])
      assert.match(
        partitions,
        /if \[ "\$NEXTEST_PROFILE" = merge-queue \]; then FILTER=\$\(node \.\.\/scripts\/check-quarantine\.mjs --filter\); fi/
      )
      assert.doesNotMatch(
        partitions,
        /rust-cache|cargo (build|test|check|clippy|nextest archive)\b/
      )
      // Every merge-queue partition keeps its JUnit report for the flaky-report job, under a name
      // lint-and-test's reports do not take.
      assert.match(
        partitions,
        /if: \$\{\{ !cancelled\(\) && github\.event_name == 'merge_group' \}\}\n(?: {8}.*\n)*? {10}name: nextest-junit-\$\{\{ matrix\.os \}\}-tests-\$\{\{ strategy\.job-index \}\}\n {10}path: crates\/target\/nextest\/merge-queue\/junit\.xml\n/
      )
      assert.match(jobs, /^ {4}needs: \[lint-and-test, test-partitions\]$/m)
    })

    // The plan job's split of rust-legs.jq: lint-and-test gets the legs with no partition,
    // test-partitions every partition, and test-archive one leg per OS of those partitions.
    it('splits every tier into the legs, the partitions and one archive per partition OS', () => {
      const plan = job('plan')
      const split = (name) =>
        plan.match(new RegExp(`^ {10}${name}=\\$\\(jq -c '([^']+)' <<<"\\$(\\w+)"\\)$`, 'm'))
      const jq = (filter, input) => {
        const out = spawnSync('jq', ['-c', filter], {
          input: JSON.stringify(input),
          encoding: 'utf8'
        })
        assert.equal(out.status, 0, out.stderr)
        return JSON.parse(out.stdout)
      }
      const [legsFilter, partitionsFilter, archivesFilter] = ['legs', 'partitions', 'archives'].map(
        (name) => {
          const m = split(name)
          assert.ok(m, name)
          return m
        }
      )
      assert.equal(legsFilter[2], 'all')
      assert.equal(partitionsFilter[2], 'all')
      assert.equal(archivesFilter[2], 'partitions')
      const legsJq = join(repo, '.github/actions/ci-tier/rust-legs.jq')
      for (const [full, postMerge, event, win, mac, base] of [
        ['false', 'false', 'pull_request', 'none', 'none', 'feat/tauri-v2'],
        ['false', 'false', 'pull_request', 'tests', 'tests', 'feat/tauri-v2'],
        ['true', 'false', 'merge_group', 'none', 'none', ''],
        ['true', 'false', 'pull_request', 'none', 'none', 'main'],
        ['true', 'false', 'pull_request', 'none', 'none', 'feat/tauri-v2'],
        ['false', 'true', 'schedule', 'none', 'none', '']
      ]) {
        const all = JSON.parse(
          spawnSync(
            'jq',
            [
              '-cn',
              '--arg',
              'full',
              full,
              '--arg',
              'macos',
              'true',
              '--arg',
              'intel',
              'false',
              '--arg',
              'post_merge',
              postMerge,
              '--arg',
              'win',
              win,
              '--arg',
              'mac',
              mac,
              '--arg',
              'event',
              event,
              '--arg',
              'base',
              base,
              '-f',
              legsJq
            ],
            { encoding: 'utf8' }
          ).stdout
        )
        const legs = jq(legsFilter[1], all)
        const parts = jq(partitionsFilter[1], all)
        const archives = jq(archivesFilter[1], parts)
        const where = `${event} full=${full} base=${base}`
        assert.equal(legs.length + parts.length, all.length, where)
        assert.ok(parts.length > 0, where)
        assert.ok(
          legs.every((l) => !l.partition),
          where
        )
        for (const p of parts)
          assert.deepEqual(Object.keys(p).toSorted(), ['os', 'part', 'partition', 'tests'], where)
        // Every OS with partitions has all of them (six; four for macos-15) and one archive. macos-15
        // splits its suite only on a PR into a base other than main; every other macOS leg runs it
        // whole. jq's `unique` orders by code point.
        const oses = [...new Set(parts.map((p) => p.os))].toSorted((a, b) => (a < b ? -1 : 1))
        assert.deepEqual(
          archives,
          oses.map((os) => ({ os })),
          where
        )
        const splitMac =
          event === 'pull_request' && base !== 'main' && (full === 'true' || mac === 'tests')
        assert.equal(oses.includes('macos-15'), splitMac, where)
        assert.ok(!legs.some((l) => l.os === 'macos-15' && l.tests) || !splitMac, where)
        for (const os of oses) {
          assert.ok(!os.startsWith('macos') || os === 'macos-15', where)
          const n = os === 'macos-15' ? 4 : 6
          assert.deepEqual(
            parts.filter((p) => p.os === os).map((p) => p.partition),
            Array.from({ length: n }, (_, i) => `${i + 1}/${n}`),
            `${where} ${os}`
          )
        }
      }
    })
  })

  // The legs of rust-legs.jq carry the step groups they run; a step must name one of those groups, so
  // a leg the matrix no longer emits (the old `checks` part) cannot leave steps that never run.
  it('runs every Rust leg step under a step group rust-legs.jq emits', () => {
    const lintAndTest = jobs.slice(
      jobs.indexOf('\n  lint-and-test:\n'),
      jobs.indexOf('\n  test-archive:\n')
    )
    const legs = readFileSync(join(repo, '.github/actions/ci-tier/rust-legs.jq'), 'utf8')
    const groups = ['lint', 'seams', 'budget', 'tests', 'perf', 'models']
    for (const group of groups) assert.match(legs, new RegExp(`\\b${group}: true\\b`), group)
    for (const [, cond] of lintAndTest.matchAll(/^ {8}if: (.*)$/gm)) {
      for (const [, field] of cond.matchAll(/matrix\.([a-z]+)/g))
        assert.ok(['os', 'partition', ...groups].includes(field), cond)
      assert.doesNotMatch(cond, /matrix\.part/, cond)
    }
    // The live seams and the release read-pool test skip a PR into feat/tauri-v2 only, and never on
    // macOS, which the merge queue does not run.
    assert.match(
      lintAndTest,
      /^ {6}LIVE_SEAMS: \$\{\{ !\(github\.event_name == 'pull_request' && github\.base_ref == 'feat\/tauri-v2'\) \|\| startsWith\(matrix\.os, 'macos'\) \}\}$/m
    )
    for (const name of [
      'Keychain seam, live OS secrets (Linux)',
      'Test (memry-core, read pool contention, release)'
    ])
      assert.match(
        lintAndTest,
        new RegExp(
          `- name: ${name.replace(/[()]/g, '\\$&')}\\n {8}if: .*env\\.LIVE_SEAMS == 'true'`
        ),
        name
      )
  })

  it('retries every nextest run of a merge-queue run', () => {
    const profile = `NEXTEST_PROFILE: \${{ github.event_name == 'merge_group' && 'merge-queue' || 'default' }}`
    const ids = [...jobs.matchAll(/^ {2}([a-z0-9-]+):\n/gm)].map((m) => m[1])
    for (const [i, id] of ids.entries()) {
      const start = jobs.indexOf(`\n  ${id}:\n`)
      const end = i + 1 < ids.length ? jobs.indexOf(`\n  ${ids[i + 1]}:\n`) : undefined
      const job = jobs.slice(start, end)
      if (!/cargo nextest run/.test(job)) continue
      assert.ok(job.includes(`\n      ${profile}\n`), id)
      // Only the live seams pick another profile; nothing pins `default` past the job env.
      for (const [run] of job.matchAll(/cargo nextest run[^\n']*/g))
        if (/--profile/.test(run)) assert.match(run, /--profile live /, run)
    }
  })

  it('saves the cargo caches only on feat/tauri-v2', () => {
    const saves = [
      ...workflow.matchAll(/uses: Swatinem\/rust-cache@v2\n(?: {8}.*\n)*? {10}save-if: (.*)\n/g)
    ].map((m) => m[1])
    assert.equal(saves.length, [...workflow.matchAll(/uses: Swatinem\/rust-cache@v2/g)].length)
    // test-archive restores lint-and-test's entry and saves none.
    for (const save of saves)
      if (save !== 'false') assert.match(save, /github\.ref == 'refs\/heads\/feat\/tauri-v2'/, save)
  })

  // Every per-ref save of a large entry fills the repo's 10 GB cache cap and evicts feat/tauri-v2's
  // cargo entries, which PRs and the merge queue restore. Each cache step of every workflow and local
  // action saves only on feat/tauri-v2 (main too where a step serves main's runs) and restores elsewhere.
  it('saves every workflow cache only on feat/tauri-v2', () => {
    const dirs = [
      '.github/workflows',
      ...readdirSync(join(repo, '.github/actions')).map((a) => `.github/actions/${a}`)
    ]
    const files = dirs.flatMap((dir) =>
      readdirSync(join(repo, dir))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => join(dir, f))
    )
    const feat = /github\.ref == 'refs\/heads\/feat\/tauri-v2'/
    let checked = 0
    for (const file of files) {
      const lines = readFileSync(join(repo, file), 'utf8').split('\n')
      // The step around line i: from its `- ` line to the next item at the same indent.
      const step = (i) => {
        let start = i
        while (!/^\s*- /.test(lines[start])) start--
        const indent = lines[start].search(/-/)
        let end = start + 1
        while (end < lines.length && !(lines[end].search(/\S/) <= indent && lines[end].trim()))
          end++
        return lines.slice(start, end).join('\n')
      }
      for (const [i, line] of lines.entries()) {
        if (/^\s*#/.test(line)) continue
        const where = `${file}:${i + 1}`
        if (/uses: Swatinem\/rust-cache@/.test(line)) {
          const save = step(i).match(/save-if: (.*)/)?.[1] ?? ''
          assert.ok(feat.test(save) || save === 'false', `${where} save-if: ${save}`)
        } else if (/uses: actions\/cache(\/save)?@/.test(line)) {
          const cond = step(i).match(/^\s*(?:- )?if: (.*)$/m)?.[1] ?? ''
          // tesseract-sources saves when its `save` input says so; its callers are checked below.
          assert.ok(feat.test(cond) || cond === "inputs.save == 'true'", `${where} if: ${cond}`)
        } else if (/uses: \.\/\.github\/actions\/tesseract-sources/.test(line)) {
          const save = step(i).match(/save: (.*)/)?.[1] ?? ''
          assert.ok(feat.test(save), `${where} save: ${save}`)
        } else if (/^\s*cache: /.test(line)) {
          assert.match(line, feat, where)
        } else continue
        checked++
      }
    }
    assert.ok(checked > 20, `only ${checked} cache steps found`)
  })

  it('reports the latest finished gate of a real run in a noop run into main', () => {
    const bin = mkdtempSync(join(tmpdir(), 'rust-ci-gate-'))
    try {
      // A stand-in `gh` that answers the check-runs query with the conclusion it is given.
      writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf "%s" "$LATEST"\n')
      chmodSync(join(bin, 'gh'), 0o755)
      const path = `${bin}:${process.env.PATH}`
      // Every needed job is skipped in a noop run, so only the mirrored conclusion decides.
      const noopRun = { MIRROR: 'true', DETECT_RESULT: 'skipped', RESULTS: 'skipped skipped' }
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: 'success' }), 0)
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: 'failure' }), 1)
      // No real run has finished yet: red until that run's own gate supersedes this one.
      assert.equal(runGate({ ...noopRun, PATH: path, LATEST: '' }), 1)
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })
})
