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
//! (stored with its outbox row, committed, fanned out), sync step 1 (`state_diff` and the state
//! vector) and the quit's `flush-writebacks` of an edited note (the body serialized and the file
//! written). The notes are a 2 KB and a 12 KB note and a long note of 5000 blocks.
//!
//! Budgets are p95 in milliseconds, release build. The issue's own: open of a 12 KB note 25, of
//! a 2 KB note 8, `apply_update` of a 200-byte update 2. The others are about 3x the worst p95 of
//! five runs on an Apple M5 Pro (the numbers are in the PR of slice 14z): open of the long note
//! 100 (measured 31), sync step 1 of a current window 2 (0.4) and of an empty one 10 (3), the
//! write-back 1000 (p50 160, p95 up to 570 under disk load). Edits are a keystroke apart
//! ([`KEYSTROKE`]); `apply_update`'s p95 is its commit's WAL write, which a busy disk stretches.
//! The test prints p50 and p95 and only reports a miss; `MEMRY_PERF_ENFORCE=1` turns a miss into
//! a failure, and `MEMRY_PERF_FACTOR` scales every budget (a shared CI runner is slower).

mod device_key;
mod vault_env;

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::crdt::BODY_FRAGMENT;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::editor::{EditorHost, Subscriber};
use vault_env::{Env, creates, env, indexed};
use yrs::updates::decoder::Decode as _;
use yrs::updates::encoder::Encode as _;
use yrs::{
    Doc, ReadTxn as _, Text as _, Transact as _, Update, XmlFragment as _, XmlOut, XmlTextRef,
};

const WINDOW: &str = "main";

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

fn percentiles(mut samples: Vec<Duration>) -> (Duration, Duration) {
    samples.sort();
    (
        samples[samples.len() / 2],
        samples[samples.len() * 95 / 100],
    )
}

/// The window's copy of the document, as the renderer's editor holds it.
struct Window(Doc);

impl Window {
    fn from_state(state: &[u8]) -> Self {
        let doc = Doc::new();
        doc.transact_mut()
            .apply_update(Update::decode_v1(state).unwrap())
            .unwrap();
        Self(doc)
    }

    /// Types `text` at the start of the first block's text and returns the update the editor
    /// sends.
    fn type_text(&self, text: &str) -> Vec<u8> {
        let fragment = self.0.get_or_insert_xml_fragment(BODY_FRAGMENT);
        let before = self.0.transact().state_vector();
        let mut txn = self.0.transact_mut();
        let first = (0..fragment.len(&txn))
            .find_map(|i| {
                fragment
                    .get(&txn, i)
                    .and_then(|node| first_text(&txn, node))
            })
            .expect("a block with text");
        first.insert(&mut txn, 0, text);
        drop(txn);
        self.0.transact().encode_diff_v1(&before)
    }

    fn state_vector(&self) -> Vec<u8> {
        self.0.transact().state_vector().encode_v1()
    }
}

/// The first text node under `node`, depth first: blocks nest (group, container, content).
fn first_text(txn: &impl yrs::ReadTxn, node: XmlOut) -> Option<XmlTextRef> {
    match node {
        XmlOut::Text(text) => Some(text),
        XmlOut::Element(element) => {
            (0..element.len(txn)).find_map(|i| element.get(txn, i).and_then(|n| first_text(txn, n)))
        }
        XmlOut::Fragment(_) => None,
    }
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
        let count = samples.len();
        let (p50, p95) = percentiles(samples);
        let factor = self.factor;
        println!("{what}: p50 {p50:?}, p95 {p95:?}, n {count} (budget {budget_ms} ms x {factor})");
        if p95.as_secs_f64() * 1000.0 > budget_ms * factor {
            self.failures.push(format!(
                "{what}: p95 {p95:?} over {budget_ms} ms x {factor}"
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
        ("long.md", "5000 blocks", 20, 100.0),
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

    let samples = (0..20)
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
