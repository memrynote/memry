//! The converter's time budget (issue #3522, "Performance"). Ignored by default
//! because the numbers mean something in a release build only:
//!
//! `cargo test -p memry-core --features markdown --release --test markdown_perf
//! markdown_perf_budget -- --ignored --nocapture`
//!
//! Budgets, release build on an Apple M1: `doc_to_markdown` of the 49 KB note at
//! most 60 ms p95, of a 2 KB note at most 3 ms p95, `prepare_seed` of the 49 KB
//! note at most 80 ms p95. `MEMRY_PERF_FACTOR` scales them (Windows and Linux
//! runs may take twice as long).

#![cfg(feature = "markdown")]

mod support;

use std::time::{Duration, Instant};

use memry_core::markdown::convert::NoEmbeds;
use memry_core::markdown::convert::restore::SerializeOptions;
use support::doc_case::{FRAGMENT, build_document, converter_for, files_of};

const SECTION: &str = "## Weekly review {n}

A paragraph with **bold**, *italic*, `code`, a [link](https://example.com/{n}) and a [[Wiki Link {n}]] #tag{n}, long enough to wrap in the editor and to cost something to parse.

- first item with some words
  - nested item {n}
    - deeper item
- [ ] open task {n}
- [x] done task

1. numbered one
2. numbered two

> A quote about week {n}, kept short.

| Name | Value |
| --- | --- |
| alpha | {n} |
| beta | two |

```rust
fn week_{n}() -> u32 {
    {n}
}
```

";

fn note(bytes: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    while out.len() < bytes {
        out.push_str(&SECTION.replace("{n}", &n.to_string()));
        n += 1;
    }
    out
}

fn percentiles(mut samples: Vec<Duration>) -> (Duration, Duration) {
    samples.sort();
    (
        samples[samples.len() / 2],
        samples[samples.len() * 95 / 100],
    )
}

fn measure(iterations: usize, mut work: impl FnMut()) -> (Duration, Duration) {
    work();
    let samples = (0..iterations)
        .map(|_| {
            let start = Instant::now();
            work();
            start.elapsed()
        })
        .collect();
    percentiles(samples)
}

#[test]
#[ignore = "timing: run in a release build, see the module docs"]
fn markdown_perf_budget() {
    let factor: f64 = std::env::var("MEMRY_PERF_FACTOR")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1.0);
    let big = note(49_000);
    let small = note(2_000);
    let input = serde_json::json!({});
    let converter = converter_for(&input);
    let files = files_of(&input);
    let options = SerializeOptions::default();
    let mut failures = Vec::new();
    let mut report = |what: &str, (p50, p95): (Duration, Duration), budget_ms: f64| {
        println!("{what}: p50 {p50:?}, p95 {p95:?} (budget {budget_ms} ms x {factor})");
        if p95.as_secs_f64() * 1000.0 > budget_ms * factor {
            failures.push(format!(
                "{what}: p95 {p95:?} over {budget_ms} ms x {factor}"
            ));
        }
    };

    for (label, markdown, budget) in [("49 KB", &big, 60.0), ("2 KB", &small, 3.0)] {
        let input = serde_json::json!({ "markdown": markdown });
        let document = build_document(&converter, &input, &files).expect("seed");
        let times = measure(200, || {
            converter
                .doc_to_markdown(&document, FRAGMENT, &options)
                .expect("serialize");
        });
        report(&format!("doc_to_markdown {label}"), times, budget);
    }
    let times = measure(200, || {
        converter
            .prepare_seed(&big, None, None, &NoEmbeds)
            .expect("prepare");
    });
    report("prepare_seed 49 KB", times, 80.0);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
