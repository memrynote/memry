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

#[test]
fn a_long_table_plans_in_linear_time() {
    let rows = "| 1 | 2 |\n".repeat(3000);
    let plan = within("table rows", format!("| a | b |\n|---|---|\n{rows}"), BOUND);
    assert_eq!(plan.blocks.len(), 1);
}

#[test]
fn a_long_run_of_indented_lines_plans_in_linear_time() {
    for (label, head) in [("paragraph", "x\n"), ("list item", "- a\n")] {
        let plan = within(label, format!("{head}{}", "  y\n".repeat(3000)), BOUND);
        assert_eq!(plan.blocks.len(), 1, "{label}");
    }
    let breaks = format!("a{}", " \\\n".repeat(3000));
    within("trailing backslashes", breaks, BOUND);
}

/// Backtick runs of length 1, 2, 3, ...: no run has a partner of its length,
/// so each scans to the end of the text for one.
fn unmatched_runs(count: usize) -> String {
    (1..=count)
        .map(|n| format!("{} a ", "`".repeat(n)))
        .collect()
}

#[test]
fn unmatched_backtick_runs_in_a_paragraph_plan_in_linear_time() {
    within("runs in a paragraph", unmatched_runs(250), BOUND);
}

#[test]
fn unmatched_backtick_runs_on_a_pipe_line_plan_in_linear_time() {
    within(
        "runs on a pipe line",
        format!("a | {}", unmatched_runs(250)),
        BOUND,
    );
}

#[test]
fn unmatched_backtick_runs_in_a_table_cell_plan_in_linear_time() {
    let table = format!("| h |\n|---|\n| {} |", unmatched_runs(250));
    let plan = within("runs in a table cell", table, BOUND);
    assert_eq!(plan.blocks.len(), 1);
}

#[test]
fn unmatched_backtick_runs_beside_a_comment_plan_in_linear_time() {
    let text = format!("%% x %% {}", unmatched_runs(250));
    within("runs beside a comment", text, BOUND);
}

#[test]
fn one_long_backtick_run_plans_in_linear_time() {
    within("one run", format!("a{}", "`".repeat(8000)), BOUND);
}

#[test]
fn adjacent_html_comments_on_one_line_plan_in_linear_time() {
    within("html comments", "<!-- a -->".repeat(4000), BOUND);
    within("html comments, spaced", "<!-- a --> ".repeat(4000), BOUND);
}

#[test]
fn adjacent_percent_comments_beside_code_spans_plan_in_linear_time() {
    within("%% comments", "%% a %%".repeat(8000), BOUND);
    within("%% comments, code spans", "`a`%% a %%".repeat(4000), BOUND);
}

#[test]
fn many_comments_in_a_table_row_plan_in_linear_time() {
    let row = format!("| {} |", "<!-- a --> ".repeat(4000));
    within("comments in a table row", row, BOUND);
}

#[test]
fn many_unclosed_html_comments_before_a_fence_plan_in_linear_time() {
    let text = format!("{}```\n", "x <!--\n".repeat(4000));
    within("unclosed comments, then a fence", text, BOUND);
}

#[test]
fn a_list_item_of_many_hard_breaks_plans_in_linear_time() {
    let text = format!("- a  \n{}", "b  \n".repeat(2000));
    within("hard breaks in a list item", text, BOUND);
}

#[test]
fn a_list_item_whose_link_text_spans_many_lines_plans_in_linear_time() {
    let text = format!("- [a\n{}c](u)", "b\n".repeat(2000));
    within("link text over many lines", text, BOUND);
}
