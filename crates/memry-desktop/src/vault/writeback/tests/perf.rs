//! What one pass costs on a 12 KB note (#3529 acceptance, the Step 05 budget of 20 ms on an
//! M1), and what a fresh device's first files cost, alone and beside a busy database writer
//! (#5410). Measurements, not tests: they print and assert no time.
//!
//! `cargo test -p memry-desktop --release writeback_perf -- --ignored --nocapture`
//! `cargo test -p memry-desktop --release writeback_first_files -- --ignored --nocapture`

use std::time::{Duration, Instant};

use super::*;

/// About `size` bytes of the blocks a note is made of: headings, paragraphs with marks and
/// links, bullet, numbered and check lists, quotes and code.
fn note_of(size: usize) -> String {
    let mut text = String::from("---\ntitle: Bench\ntags:\n  - perf\n---\n");
    for n in 0.. {
        if text.len() >= size {
            break;
        }
        text.push_str(&format!(
            "## Section {n}\n\n\
             A paragraph with **bold**, *italic* and `code` words, and a [link](https://example.com/{n}).\n\n\
             - a bullet item {n}\n- another bullet item\n\n\
             1. first step\n2. second step\n\n\
             - [ ] an open task {n}\n- [x] a done task\n\n\
             > a quoted line {n}\n\n\
             ```rust\nfn f{n}() -> u32 {{ {n} }}\n```\n\n"
        ));
    }
    text
}

fn summary(label: &str, took: &mut [Duration]) -> String {
    took.sort();
    let at = |q: f64| took[((took.len() - 1) as f64 * q).round() as usize];
    format!(
        "{label}: n={} min {:?} median {:?} p90 {:?} max {:?}",
        took.len(),
        took[0],
        at(0.5),
        at(0.9),
        took[took.len() - 1]
    )
}

#[test]
#[ignore = "a measurement: cargo test -p memry-desktop --release writeback_perf -- --ignored --nocapture"]
fn writeback_perf() {
    let mut f = fixture();
    let text = note_of(12 * 1024);
    let id = f.adopt("n.md", &text);
    let mut took = Vec::new();
    for n in 0..51 {
        f.edit_in_app(&id, &format!("typed {n}"));
        let started = Instant::now();
        let outcome = f.run(&id);
        took.push(started.elapsed());
        assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
        f.facts();
    }
    // The first write replaces bytes the app did not write, so it keeps them as a version.
    let first = took.remove(0);
    eprintln!(
        "writeback_perf: {} B file, first pass {first:?} (keeps a version); {}",
        f.read("n.md").len(),
        summary("passes after an edit", &mut took)
    );
}

/// First files of `n` pulled notes (no row, no file, body here), one pass each, with another
/// thread taking the database writer 5 ms at a time when `busy` (a sync apply or an indexer).
fn first_files(n: usize, busy: bool) {
    use std::sync::atomic::{AtomicBool, Ordering};
    let mut f = fixture();
    f.rows.lane_of(f.pass.session).unwrap().set_walked(true);
    let ids: Vec<String> = (0..n)
        .map(|i| {
            let folder = format!("F{}", i % 50);
            f.writer.create(format!("Note {i}"), Some(folder)).unwrap()
        })
        .collect();
    let stop = Arc::new(AtomicBool::new(false));
    let busy_thread = busy.then(|| {
        let (db, stop) = (f.vault.db_handle(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                db.call_blocking(|_| {
                    std::thread::sleep(Duration::from_millis(5));
                    Ok(())
                })
                .unwrap();
            }
        })
    });
    let started = Instant::now();
    let mut took = Vec::new();
    for id in &ids {
        let pass = Instant::now();
        let outcome = f.run(id);
        took.push(pass.elapsed());
        assert!(matches!(outcome, Outcome::Wrote { .. }), "{outcome:?}");
    }
    let total = started.elapsed();
    stop.store(true, Ordering::Relaxed);
    if let Some(thread) = busy_thread {
        thread.join().unwrap();
    }
    f.facts();
    eprintln!(
        "writeback_first_files busy={busy}: {n} files in {total:?} ({:.0}/s); {}",
        n as f64 / total.as_secs_f64(),
        summary("passes", &mut took)
    );
}

#[test]
#[ignore = "a measurement: cargo test -p memry-desktop --release writeback_first_files -- --ignored --nocapture"]
fn writeback_first_files() {
    first_files(2000, false);
}

#[test]
#[ignore = "a measurement: cargo test -p memry-desktop --release writeback_first_files -- --ignored --nocapture"]
fn writeback_first_files_beside_a_busy_writer() {
    first_files(300, true);
}
