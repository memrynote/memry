//! Pasted or seeded markdown is untrusted: a pathological text must plan in
//! bounded time and stack, never hang the main thread or abort the process.
//! Each timing case plans a shape at size `n` and `4n` and checks the ratio,
//! so a loaded runner slows both runs alike and the check holds where a
//! wall-clock bound flakes.

use std::sync::{Mutex, mpsc};
use std::time::{Duration, Instant};

use memry_core::crdt::markdown_seed::{SeedPlan, plan};

/// The stack a default test thread (and an iOS secondary thread) gets.
const STACK: usize = 2 << 20;

/// One timed plan at a time, so the tests of this file, which cargo runs in
/// parallel, do not slow each other's measurements.
static TIMING: Mutex<()> = Mutex::new(());

/// `plan(markdown)` on a 2 MB stack, with how long it took. A hang fails on
/// the channel timeout, a stack overflow aborts the test process.
fn planned(markdown: String) -> (SeedPlan, Duration) {
    let _alone = TIMING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
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

/// 4× the input may take at most 8× the time. A linear pass takes about 4×,
/// a quadratic one about 16×. Each size keeps its best of 5 runs, and the
/// sizes alternate so a busy spell on the runner slows both alike. Returns
/// the plan of the larger input.
fn scales_linearly(label: &str, n: usize, shape: impl Fn(usize) -> String) -> SeedPlan {
    let mut small = Duration::MAX;
    let mut large = Duration::MAX;
    let mut plan = None;
    for _ in 0..5 {
        small = small.min(planned(shape(n)).1);
        let (larger, elapsed) = planned(shape(4 * n));
        large = large.min(elapsed);
        plan = Some(larger);
    }
    let ratio = large.as_secs_f64() / small.as_secs_f64();
    eprintln!("{label}: n={n} in {small:?}, 4n in {large:?}, {ratio:.1}x");
    assert!(
        ratio <= 8.0,
        "{label}: 4x the input took {ratio:.1}x the time ({small:?} -> {large:?})"
    );
    plan.expect("five runs")
}

#[test]
fn a_comment_marker_before_a_long_quote_chain_plans_fast() {
    scales_linearly("%% then > chain", 5, |n| format!("%%\n{}x", "> ".repeat(n)));
}

#[test]
fn a_long_table_plans_in_linear_time() {
    let plan = scales_linearly("table rows", 750, |n| {
        format!("| a | b |\n|---|---|\n{}", "| 1 | 2 |\n".repeat(n))
    });
    assert_eq!(plan.blocks.len(), 1);
}

#[test]
fn a_long_run_of_indented_lines_plans_in_linear_time() {
    for (label, head) in [("paragraph", "x\n"), ("list item", "- a\n")] {
        let plan = scales_linearly(label, 750, |n| format!("{head}{}", "  y\n".repeat(n)));
        assert_eq!(plan.blocks.len(), 1, "{label}");
    }
    scales_linearly("trailing backslashes", 750, |n| {
        format!("a{}", " \\\n".repeat(n))
    });
}

/// Backtick runs of length 1, 2, 3, ...: no run has a partner of its length,
/// so each scans to the end of the text for one. The text grows with the
/// square of the run count, so `size` bytes take about `sqrt(2 * size)` runs.
fn unmatched_runs(size: usize) -> String {
    (1..=(2 * size).isqrt())
        .map(|n| format!("{} a ", "`".repeat(n)))
        .collect()
}

#[test]
fn unmatched_backtick_runs_in_a_paragraph_plan_in_linear_time() {
    scales_linearly("runs in a paragraph", 8000, unmatched_runs);
}

#[test]
fn unmatched_backtick_runs_on_a_pipe_line_plan_in_linear_time() {
    scales_linearly("runs on a pipe line", 8000, |n| {
        format!("a | {}", unmatched_runs(n))
    });
}

#[test]
fn unmatched_backtick_runs_in_a_table_cell_plan_in_linear_time() {
    let plan = scales_linearly("runs in a table cell", 8000, |n| {
        format!("| h |\n|---|\n| {} |", unmatched_runs(n))
    });
    assert_eq!(plan.blocks.len(), 1);
}

#[test]
fn unmatched_backtick_runs_beside_a_comment_plan_in_linear_time() {
    scales_linearly("runs beside a comment", 8000, |n| {
        format!("%% x %% {}", unmatched_runs(n))
    });
}

#[test]
fn one_long_backtick_run_plans_in_linear_time() {
    scales_linearly("one run", 2000, |n| format!("a{}", "`".repeat(n)));
}

#[test]
fn adjacent_html_comments_on_one_line_plan_in_linear_time() {
    scales_linearly("html comments", 1000, |n| "<!-- a -->".repeat(n));
    scales_linearly("html comments, spaced", 1000, |n| "<!-- a --> ".repeat(n));
}

#[test]
fn adjacent_percent_comments_beside_code_spans_plan_in_linear_time() {
    scales_linearly("%% comments", 2000, |n| "%% a %%".repeat(n));
    scales_linearly("%% comments, code spans", 1000, |n| "`a`%% a %%".repeat(n));
}

#[test]
fn many_comments_in_a_table_row_plan_in_linear_time() {
    scales_linearly("comments in a table row", 1000, |n| {
        format!("| {} |", "<!-- a --> ".repeat(n))
    });
}

#[test]
fn many_unclosed_html_comments_before_a_fence_plan_in_linear_time() {
    scales_linearly("unclosed comments, then a fence", 1000, |n| {
        format!("{}```\n", "x <!--\n".repeat(n))
    });
}

#[test]
fn a_list_item_of_many_hard_breaks_plans_in_linear_time() {
    scales_linearly("hard breaks in a list item", 500, |n| {
        format!("- a  \n{}", "b  \n".repeat(n))
    });
}

#[test]
fn a_list_item_whose_link_text_spans_many_lines_plans_in_linear_time() {
    scales_linearly("link text over many lines", 500, |n| {
        format!("- [a\n{}c](u)", "b\n".repeat(n))
    });
}

/// A recursive pass over nested input must stop at a depth the stack holds.
/// `planned` runs on 2 MB, and a stack overflow aborts the whole process.
#[test]
fn deeply_nested_links_plan_without_overflowing_the_stack() {
    let text = format!("{}{}", "[a".repeat(3500), "](u)".repeat(3500));
    let plan = within("nested links", text, Duration::from_secs(5));
    assert_eq!(plan.blocks.len(), 1);
}

#[test]
fn deeply_nested_toggles_plan_without_overflowing_the_stack() {
    let open = "<details data-memry-toggle>\n<summary>s</summary>\n".repeat(3000);
    let text = format!("{open}x\n{}", "</details>\n".repeat(3000));
    within("nested toggles", text, Duration::from_secs(5));
}

#[test]
fn deeply_nested_lists_plan_without_overflowing_the_stack() {
    let text: String = (0..600)
        .map(|i| format!("{}- a\n", "  ".repeat(i)))
        .collect();
    within("nested lists", text, Duration::from_secs(30));
}

#[test]
fn a_heading_with_a_long_whitespace_run_plans_in_linear_time() {
    let plan = scales_linearly("heading, whitespace run", 5000, |n| {
        format!("# a{}x", " ".repeat(n))
    });
    assert_eq!(plan.blocks.len(), 1);
    scales_linearly("heading, whitespace runs around a mark", 5000, |n| {
        let spaces = " ".repeat(n);
        format!("# a{spaces}#{spaces}x")
    });
}

const TOGGLE: &str = "<details data-memry-toggle>\n<summary>s</summary>\n";

#[test]
fn many_unclosed_toggles_plan_in_linear_time() {
    scales_linearly("unclosed toggles", 750, |n| TOGGLE.repeat(n));
    scales_linearly("unclosed toggles, one closer", 750, |n| {
        format!("{}</details>\n", TOGGLE.repeat(n))
    });
}

#[test]
fn many_unclosed_toggles_between_fences_plan_in_linear_time() {
    scales_linearly("unclosed toggles, fenced", 750, |n| {
        format!("{TOGGLE}```\n").repeat(n)
    });
}

#[test]
fn a_list_item_over_many_whitespace_lines_plans_in_linear_time() {
    let plan = scales_linearly("whitespace lines in a list item", 2000, |n| {
        format!("- a\n{}  b", " \n".repeat(n))
    });
    assert_eq!(plan.blocks.len(), 1);
}
