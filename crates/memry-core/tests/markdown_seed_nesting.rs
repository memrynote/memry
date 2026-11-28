//! A handled tag nests in desktop's HTML parse, so desktop reads the ones past
//! 100 open as text (`inline/raw-html.ts`). The core keeps every line holding
//! one literal, and must plan the same inputs in time linear in their size, on
//! the stack a secondary thread gets.
//!
//! Its own test binary: these inputs are big enough to slow the timing bounds
//! of `markdown_seed_limits.rs` if the two shared a process.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use memry_core::crdt::markdown_seed::{SeedPlan, plan};

/// The stack a default test thread (and an iOS secondary thread) gets.
const STACK: usize = 2 << 20;

/// `plan(markdown)` on a 2 MB stack, with how long it took.
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

/// The time `plan` takes on `make(depth)`, the best of two runs: load on the
/// machine only ever adds to a run.
fn best_of_two(make: &dyn Fn(usize) -> String, depth: usize) -> Duration {
    (0..2)
        .map(|_| planned(make(depth)).1)
        .min()
        .expect("two runs")
}

/// Eight times the depth costs well under the sixty-four times a quadratic
/// pass does.
#[test]
fn deeply_nested_handled_tags_plan_in_linear_time() {
    let shapes: [(&str, &dyn Fn(usize) -> String); 6] = [
        ("<b>", &|n| format!("{}x", "<b>".repeat(n))),
        ("<b>..</b>", &|n| {
            format!("{}x{}", "<b>".repeat(n), "</b>".repeat(n))
        }),
        ("<span style>", &|n| {
            format!("{}x", "<span style=\"color:red\">".repeat(n))
        }),
        ("<span style>..</span>", &|n| {
            format!(
                "{}x{}",
                "<span style=\"color:red\">".repeat(n),
                "</span>".repeat(n)
            )
        }),
        ("<ul><li>", &|n| format!("{}x", "<ul><li>".repeat(n))),
        ("<b across lines>", &|n| {
            format!("{}x", "<b\n y=\"1\">".repeat(n))
        }),
    ];
    for (label, make) in shapes {
        let plan = planned(make(8000)).0;
        assert!(
            plan.fallbacks
                .iter()
                .all(|fallback| fallback.reason == "HTML"),
            "{label}: {:?}",
            plan.fallbacks
        );
        let small = best_of_two(make, 2000);
        let large = best_of_two(make, 16_000);
        eprintln!("{label}: 2000 in {small:?}, 16000 in {large:?}");
        assert!(
            large < small * 20 + Duration::from_millis(100),
            "{label}: 16000 took {large:?}, 2000 took {small:?}"
        );
    }
}
