//! Pasted or seeded markdown is untrusted: a pathological text must plan in
//! bounded time and stack, never hang the main thread or abort the process.
//! Each case is sized so that a quadratic or exponential pass takes seconds
//! in a debug build, where the linear one stays far under the bound.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use memry_core::crdt::markdown_seed::{SeedPlan, plan};

/// The stack a default test thread (and an iOS secondary thread) gets.
const STACK: usize = 2 << 20;

/// `plan(markdown)` on a 2 MB stack, with how long it took. A hang fails on
/// the channel timeout, a stack overflow aborts the test process.
fn planned(markdown: String) -> (SeedPlan, Duration) {
    let (send, receive) = mpsc::channel();
    std::thread::Builder::new()
        .stack_size(STACK)
        .spawn(move || {
            let started = Instant::now();
            let plan = plan(&markdown);
            let _ = send.send((plan, started.elapsed()));
        })
        .expect("spawn");
    receive
        .recv_timeout(Duration::from_secs(60))
        .expect("plan() did not finish in 60 s")
}

fn within(label: &str, markdown: String, limit: Duration) -> SeedPlan {
    let size = markdown.len();
    let (plan, elapsed) = planned(markdown);
    eprintln!("{label}: {size} bytes in {elapsed:?}");
    assert!(
        elapsed < limit,
        "{label}: {size} bytes took {elapsed:?}, over {limit:?}"
    );
    plan
}

const BOUND: Duration = Duration::from_millis(200);

#[test]
fn a_comment_marker_before_a_long_quote_chain_plans_fast() {
    within(
        "%% then > chain",
        format!("%%\n{}x", "> ".repeat(20)),
        BOUND,
    );
}
