import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = resolve(dirname(fileURLToPath(import.meta.url)), 'check-test-timing.mjs')

/** Runs the check over a tree holding one test file `crates/demo/tests/case.rs`. */
function check(source) {
  const root = mkdtempSync(join(tmpdir(), 'test-timing-'))
  try {
    const file = join(root, 'crates/demo/tests/case.rs')
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, source)
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' })
    return { status: run.status, output: run.stdout + run.stderr }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function poll(wait) {
  return `
const WAIT: Duration = ${wait};

fn eventually(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}
`
}

test('check-test-timing', async (t) => {
  await t.test('flags the assert that #3719 removed, with its line', () => {
    // vault/writeback/tests/schedule.rs before #3719: it failed a Windows merge-queue run at 511 ms.
    const { status, output } = check(`
#[test]
fn a_flush_runs_every_scheduled_pass_now_and_waits_for_them() {
    let started = Instant::now();
    assert!(writeback.flush(WAIT));
    // Now: a flush that waited for the debounce would take at least that.
    assert!(started.elapsed() < DEBOUNCE, "{:?}", started.elapsed());
}
`)
    assert.equal(status, 1, output)
    assert.match(
      output,
      /crates\/demo\/tests\/case\.rs:7: assert!\(started\.elapsed\(\) < DEBOUNCE/
    )
    assert.match(output, /code's clock or a gate/)
  })

  await t.test('lets a poll that gives up at a deadline of 5 s or more through', () => {
    const { status, output } = check(poll('Duration::from_secs(10)'))
    assert.equal(status, 0, output)
    assert.match(output, /1 deadline polls/)
  })

  await t.test('flags a poll that gives up at 500 ms', () => {
    const { status, output } = check(poll('Duration::from_millis(500)'))
    assert.equal(status, 1, output)
    assert.match(output, /case\.rs:7: assert!\(Instant::now\(\) < deadline/)
  })

  await t.test('ignores epoch timestamps and lower bounds', () => {
    const { status, output } = check(`
#[test]
fn stamped_at_apply_time() {
    let before = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis();
    let stamp = apply();
    assert!(stamp >= before, "{stamp}");
    let started = Instant::now();
    pass();
    assert!(started.elapsed() >= DEBOUNCE);
}
`)
    assert.equal(status, 0, output)
  })

  await t.test('takes a timing-bound reason, and only one that says something', () => {
    const body = (comment) => `
#[test]
fn a_watchdog() {
    let started = Instant::now();
    call();
    ${comment}
    assert!(started.elapsed() < Duration::from_secs(30));
}
`
    const kept = check(body('// timing-bound: the call returns before the 30 s watchdog'))
    assert.equal(kept.status, 0, kept.output)
    assert.match(kept.output, /1 timing-bound opt-outs/)
    assert.equal(check(body('// timing-bound: ok')).status, 1)
  })
})
