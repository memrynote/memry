//! The editor host's time budgets (#3531, "Concurrency and performance"), over a real session,
//! `data.db`, the shipped vault tier and its write-back. Ignored by default because the numbers
//! mean something in a release build only:
//!
//! ```text
//! cargo test -p memry-desktop --release --test editor_perf editor_perf -- --ignored --nocapture
//! ```
//!
//! Each row is a window's call as the Tauri commands make it: `open` of a note nobody holds
//! (the document loads from `data.db` and its state is encoded), `apply_update` of a typed edit
//! (stored with its outbox row, committed, fanned out), the bridge (a window's `apply_update` until
//! the other window's channel receives the edit), sync step 1 (`state_diff` and the state
//! vector) and the quit's `flush-writebacks` of an edited note (the body serialized and the file
//! written). The notes are a 2 KB and a 12 KB note and a long note of 5000 blocks.
//!
//! Budgets are p95 in milliseconds, release build. The issue's own: open of a 12 KB note 25, of
//! a 2 KB note 8, `apply_update` of a 200-byte update 2, and the bridge's p99 5 (its p50 budget,
//! 1, is under the p95 of `apply_update`, which the bridge includes). The others are about 3x the worst p95 of
//! five runs on an Apple M5 Pro (the numbers are in the PR of slice 14z): open of the long note
//! 100 (measured 31), sync step 1 of a current window 2 (0.4) and of an empty one 10 (3), the
//! write-back 1000 (p50 157-247, p95 243-1130 under disk load; the budget is one
//! second, and CI's quiet disk measured 496). The slow rows take 40 samples, so p95 is the
//! second-largest and not the maximum. Edits are a keystroke apart
//! ([`KEYSTROKE`]); `apply_update`'s p95 is its commit's WAL write, which a busy disk stretches.
//! The test prints p50 and p95 and only reports a miss; `MEMRY_PERF_ENFORCE=1` turns a miss into
//! a failure, and `MEMRY_PERF_FACTOR` scales every budget (a shared CI runner is slower).
//!
//! `editor_perf_ai_proxy` holds the inline AI provider proxy's rows (#3539), described in
//! [`ai_proxy_perf`].

mod ai_proxy_perf;
mod device_key;
mod editor_window;
mod vault_env;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use editor_window::Window;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHost, Subscriber};
use vault_env::{Env, creates, env, indexed};
use yrs::updates::encoder::Encode as _;

const WINDOW: &str = "main";
/// A second window with the note open, which receives the first window's edits.
const OTHER_WINDOW: &str = "second";
/// Watchdog on one delivery, not a budget.
const DELIVERY_WAIT: Duration = Duration::from_secs(25);

/// The time between two typed edits: a fast typist's keystroke. Edits sent back to back would
/// measure a burst no window sends.
const KEYSTROKE: Duration = Duration::from_millis(30);

/// About 160 bytes of text: one insert of it is an update of about 200 bytes.
const TYPED: &str = "The quick brown fox jumps over the lazy dog while the editor host stores \
                     each keystroke with its outbox row, commits it, and fans it out to windows.";

/// One block of a note, `n` making it unique.
fn block(n: usize) -> String {
    match n % 10 {
        0 => format!("## Section {n}"),
        3 | 4 => format!("- list item {n} with a few words and a [[Wiki Link {n}]]"),
        7 => format!("- [ ] open task {n} to finish this week"),
        _ => format!(
            "Paragraph {n} with **bold**, *italic*, `code` and a [link](https://example.com/{n}), \
             long enough to wrap."
        ),
    }
}

/// A note of `blocks` blocks.
fn note_of_blocks(blocks: usize) -> String {
    (0..blocks).map(block).collect::<Vec<_>>().join("\n\n") + "\n"
}

/// A note of at least `bytes` bytes.
fn note_of_bytes(bytes: usize) -> String {
    let mut out = String::new();
    let mut n = 0;
    while out.len() < bytes {
        out.push_str(&block(n));
        out.push_str("\n\n");
        n += 1;
    }
    out
}

/// p50 and the `quantile`th percentile.
fn percentiles(mut samples: Vec<Duration>, quantile: usize) -> (Duration, Duration) {
    samples.sort();
    (
        samples[samples.len() / 2],
        samples[samples.len() * quantile / 100],
    )
}

fn subscriber() -> Subscriber {
    Subscriber {
        window_label: WINDOW.to_owned(),
        channel: Arc::new(|_| true),
    }
}

struct Bench {
    env: Env,
    host: Arc<EditorHost>,
    store: Arc<dyn SecureStore>,
    /// Note id by file name.
    notes: Vec<(String, String)>,
}

impl Bench {
    /// A vault holding `files`, opened and indexed, with the editor host serving it.
    fn new(files: &[(&str, String)]) -> Self {
        let store = Mutex::new(None);
        let mut env = env(|s| {
            *store.lock().unwrap() = Some(s.clone());
            Some(creates(s))
        });
        let store = store.into_inner().unwrap().unwrap();
        let host = EditorHost::new(Arc::clone(&store), |_| {});
        host.register(&env.session);
        for (name, markdown) in files {
            env.write(name, markdown);
        }
        env.open();
        while env.rows().len() < files.len() {
            env.facts_until(indexed);
        }
        let notes = env
            .rows()
            .into_iter()
            .map(|(id, path)| (path, id))
            .collect();
        Self {
            env,
            host,
            store,
            notes,
        }
    }

    fn id(&self, file: &str) -> String {
        self.notes
            .iter()
            .find(|(path, _)| path == file)
            .map(|(_, id)| id.clone())
            .unwrap()
    }

    fn open(&self, note: &str) -> Window {
        let opened = self
            .host
            .open(note, Some(&self.env.vault), subscriber())
            .unwrap();
        Window::from_state(&opened.state)
    }

    /// The window lets go of `note` and the editor unloads it, so the next open loads it.
    fn unload(&self, note: &str) {
        self.host.close(note, WINDOW);
        let editor = self.env.core().editor(Arc::clone(&self.store)).unwrap();
        let gone = editor.sweep(i64::MAX / 2);
        assert!(gone.iter().any(|id| id == note), "{note} stayed resident");
    }
}

struct Report {
    factor: f64,
    failures: Vec<String>,
}

impl Report {
    fn new() -> Self {
        let factor = std::env::var("MEMRY_PERF_FACTOR")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1.0);
        Self {
            factor,
            failures: Vec::new(),
        }
    }

    fn row(&mut self, what: &str, samples: Vec<Duration>, budget_ms: f64) {
        self.row_at(what, samples, 95, budget_ms);
    }

    /// A row whose budget holds the `quantile`th percentile.
    fn row_at(&mut self, what: &str, samples: Vec<Duration>, quantile: usize, budget_ms: f64) {
        let count = samples.len();
        let (p50, at) = percentiles(samples, quantile);
        let factor = self.factor;
        println!(
            "{what}: p50 {p50:?}, p{quantile} {at:?}, n {count} (budget {budget_ms} ms x {factor})"
        );
        if at.as_secs_f64() * 1000.0 > budget_ms * factor {
            self.failures.push(format!(
                "{what}: p{quantile} {at:?} over {budget_ms} ms x {factor}"
            ));
        }
    }

    fn finish(self) {
        if std::env::var("MEMRY_PERF_ENFORCE").is_ok_and(|v| v == "1") {
            assert!(self.failures.is_empty(), "{}", self.failures.join("\n"));
        } else if !self.failures.is_empty() {
            println!("over budget (not enforced):\n{}", self.failures.join("\n"));
        }
    }
}

fn timed(work: impl FnOnce()) -> Duration {
    let start = Instant::now();
    work();
    start.elapsed()
}

#[test]
#[ignore = "timing: run in a release build, see the module docs"]
fn editor_perf_budget() {
    let long = note_of_blocks(5000);
    let bench = Bench::new(&[
        ("small.md", note_of_bytes(2_000)),
        ("medium.md", note_of_bytes(12_000)),
        ("long.md", long.clone()),
    ]);
    println!("long note: 5000 blocks, {} bytes", long.len());
    let mut report = Report::new();

    for (file, label, iterations, budget) in [
        ("small.md", "2 KB", 100, 8.0),
        ("medium.md", "12 KB", 100, 25.0),
        ("long.md", "5000 blocks", 40, 100.0),
    ] {
        let note = bench.id(file);
        // Warms the statement cache and the allocator; not measured.
        bench.open(&note);
        bench.unload(&note);
        let samples = (0..iterations)
            .map(|_| {
                let took = timed(|| {
                    bench.open(&note);
                });
                bench.unload(&note);
                took
            })
            .collect();
        report.row(&format!("open {label}"), samples, budget);
    }

    for (file, label, budget) in [("medium.md", "12 KB", 2.0), ("long.md", "5000 blocks", 2.0)] {
        let note = bench.id(file);
        let window = bench.open(&note);
        let first = window.type_text(TYPED);
        println!("apply_update update size: {} bytes", first.len());
        bench.host.apply_update(&note, &first, WINDOW).unwrap();
        let samples = (0..200)
            .map(|_| {
                std::thread::sleep(KEYSTROKE);
                let update = window.type_text(TYPED);
                timed(|| bench.host.apply_update(&note, &update, WINDOW).unwrap())
            })
            .collect();
        report.row(&format!("apply_update 200 B, {label}"), samples, budget);
        bench.host.close(&note, WINDOW);
    }

    let note = bench.id("medium.md");
    let window = bench.open(&note);
    let arrivals = Arc::new(Mutex::new(Vec::new()));
    let other = Subscriber {
        window_label: OTHER_WINDOW.to_owned(),
        channel: {
            let arrivals = Arc::clone(&arrivals);
            Arc::new(move |_| {
                arrivals.lock().unwrap().push(Instant::now());
                true
            })
        },
    };
    bench
        .host
        .open(&note, Some(&bench.env.vault), other)
        .unwrap();
    let samples = (0..200)
        .map(|i| {
            std::thread::sleep(KEYSTROKE);
            let update = window.type_text(TYPED);
            let sent = Instant::now();
            bench.host.apply_update(&note, &update, WINDOW).unwrap();
            loop {
                if let Some(at) = arrivals.lock().unwrap().get(i) {
                    break *at - sent;
                }
                assert!(
                    sent.elapsed() < DELIVERY_WAIT,
                    "edit {i} never reached the other window"
                );
                std::thread::yield_now();
            }
        })
        .collect();
    report.row_at("bridge to the other window, 200 B, 12 KB", samples, 99, 5.0);
    assert_eq!(arrivals.lock().unwrap().len(), 200, "one delivery per edit");
    bench.host.close(&note, WINDOW);
    bench.host.close(&note, OTHER_WINDOW);

    let note = bench.id("long.md");
    let window = bench.open(&note);
    let current = window.state_vector();
    let empty = yrs::StateVector::default().encode_v1();
    for (label, state_vector, budget) in [
        ("state_diff, window current, 5000 blocks", &current, 2.0),
        ("state_diff, empty window, 5000 blocks", &empty, 10.0),
    ] {
        let samples = (0..100)
            .map(|_| {
                timed(|| {
                    bench.host.sync_step_1(&note, state_vector, WINDOW).unwrap();
                })
            })
            .collect();
        report.row(label, samples, budget);
    }

    let samples = (0..40)
        .map(|_| {
            let update = window.type_text(TYPED);
            bench.host.apply_update(&note, &update, WINDOW).unwrap();
            bench.env.tier.schedule(&note);
            let mut flushed = false;
            let took = timed(|| flushed = bench.env.tier.flush(Duration::from_secs(60)));
            assert!(flushed, "the write-back did not finish");
            took
        })
        .collect();
    report.row("flush-on-quit write-back, 5000 blocks", samples, 1000.0);
    let written = std::fs::read_to_string(bench.env.vault.join(Path::new("long.md"))).unwrap();
    assert!(
        written.starts_with("## The quick brown fox"),
        "{}",
        &written[..80]
    );

    report.finish();
}

#[test]
#[ignore = "timing: run in a release build, see the module docs"]
fn editor_perf_ai_proxy() {
    let mut report = Report::new();
    ai_proxy_perf::run(&mut report);
    report.finish();
}
