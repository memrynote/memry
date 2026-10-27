//! Shared helpers for tests of code that reads untrusted input: markdown, YAML,
//! JSON, HTML, CRDT updates, sync payloads, vault files. A crate that adds such a
//! parser, decoder or converter tests it with these four, so every crate bounds
//! the same things in the same way:
//!
//! 1. [`on_small_stack`]: a depth test runs on a 2 MiB thread, because a stack
//!    overflow aborts the process and `catch_unwind` cannot stop it.
//! 2. [`assert_steps_at_most`]: a complexity test counts steps or visits, never
//!    wall-clock time, so it holds in debug and release and cannot flake on a slow
//!    runner.
//! 3. [`assert_output_bounded`] and [`output_bound`]: output stays within a fixed
//!    ratio of its input.
//! 4. [`proptest_config`]: properties run with the case count `PROPTEST_CASES`
//!    names and, in CI, the fixed seed. CI sets `PROPTEST_RNG_SEED` for the whole
//!    run (`rust-ci.yml`); `nightly-proptest.yml` sets a random one and replays it
//!    from the issue it opens. A test never sets a seed itself, so one value
//!    reproduces a red run.

use proptest::test_runner::Config as ProptestConfig;

/// Stack of a spawned Rust thread by default, smaller than the main thread's. The
/// depth guards are sized to it.
pub const STACK_BYTES: usize = 2 * 1024 * 1024;

/// Output may be at most this many times its input, plus [`OUTPUT_SLACK`] bytes.
pub const MAX_OUTPUT_RATIO: usize = 8;

/// Fixed overhead an output may carry on top of the ratio (a trailing newline, a
/// frontmatter fence, an empty document's skeleton).
pub const OUTPUT_SLACK: usize = 64;

/// Cases per property when `PROPTEST_CASES` is unset.
pub const DEFAULT_CASES: u32 = 2000;

/// Runs `work` on a [`STACK_BYTES`] thread and returns what it returns.
///
/// Panics when the work panics. A stack overflow is not a panic: it kills the test
/// binary, which is how a missing depth guard shows up.
pub fn on_small_stack<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(STACK_BYTES)
        .spawn(work)
        .expect("spawn the small-stack thread")
        .join()
        .expect("the work must not panic or overflow a 2 MiB stack")
}

/// Runs `work` and fails when `counter` advanced by more than `bound`.
///
/// `counter` is a monotonic step or visit count that the code under test keeps, for
/// example the loader's `depth_visits`. Counters are thread-local, so call this on
/// the thread that runs the code ([`on_small_stack`] runs it on one thread).
/// `what` names the bound in the failure message.
pub fn assert_steps_at_most(what: &str, counter: fn() -> usize, bound: usize, work: impl FnOnce()) {
    let before = counter();
    work();
    let steps = counter() - before;
    assert!(steps <= bound, "{what}: {steps} steps, bound {bound}");
}

/// The longest output, in bytes, that an input of `input_len` bytes may produce.
pub fn output_bound(input_len: usize) -> usize {
    MAX_OUTPUT_RATIO * input_len + OUTPUT_SLACK
}

/// Fails when `output_len` exceeds [`output_bound`] of `input_len`. Inside a
/// `proptest!` body use `prop_assert!(output_len <= output_bound(input_len))`, so
/// the case shrinks.
pub fn assert_output_bounded(what: &str, input_len: usize, output_len: usize) {
    assert!(
        output_len <= output_bound(input_len),
        "{what}: {output_len} bytes from {input_len}"
    );
}

/// The proptest config of every property test: `PROPTEST_CASES` cases when it parses,
/// `default_cases` otherwise. The seed stays with `PROPTEST_RNG_SEED`, which
/// `ProptestConfig::default()` reads. An explicit `cases` field would shadow the
/// variable the nightly run raises, which is why the tests do not set one.
pub fn proptest_config(default_cases: u32) -> ProptestConfig {
    ProptestConfig {
        cases: cases_from(
            std::env::var("PROPTEST_CASES").ok().as_deref(),
            default_cases,
        ),
        ..ProptestConfig::default()
    }
}

fn cases_from(env: Option<&str>, default_cases: u32) -> u32 {
    env.and_then(|cases| cases.parse().ok())
        .unwrap_or(default_cases)
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;

    use super::*;

    thread_local! {
        static STEPS: Cell<usize> = const { Cell::new(0) };
    }

    fn steps() -> usize {
        STEPS.with(Cell::get)
    }

    fn step(n: usize) {
        STEPS.with(|s| s.set(s.get() + n));
    }

    #[test]
    fn cases_follow_the_environment_only_when_it_parses() {
        assert_eq!(cases_from(Some("50"), 2000), 50);
        assert_eq!(cases_from(Some("many"), 2000), 2000);
        assert_eq!(cases_from(None, 2000), 2000);
    }

    #[test]
    fn a_small_stack_returns_what_the_work_returns() {
        assert_eq!(on_small_stack(|| 7), 7);
    }

    #[test]
    #[should_panic(expected = "the work must not panic")]
    fn a_panic_in_the_work_fails_the_caller() {
        on_small_stack(|| panic!("boom"));
    }

    #[test]
    fn steps_within_the_bound_pass_and_the_baseline_is_ignored() {
        step(1_000);
        assert_steps_at_most("ten steps", steps, 10, || step(10));
    }

    #[test]
    #[should_panic(expected = "eleven steps: 11 steps, bound 10")]
    fn steps_over_the_bound_fail_with_the_count() {
        assert_steps_at_most("eleven steps", steps, 10, || step(11));
    }

    #[test]
    fn output_bound_is_the_ratio_plus_the_slack() {
        assert_eq!(output_bound(0), OUTPUT_SLACK);
        assert_eq!(output_bound(10), 8 * 10 + OUTPUT_SLACK);
        assert_output_bounded("exactly at the bound", 10, output_bound(10));
    }

    #[test]
    #[should_panic(expected = "grew: 145 bytes from 10")]
    fn output_over_the_bound_fails_with_both_lengths() {
        assert_output_bounded("grew", 10, output_bound(10) + 1);
    }
}
