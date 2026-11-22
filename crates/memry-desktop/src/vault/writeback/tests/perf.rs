//! What one pass costs on a 12 KB note (#3529 acceptance, the Step 05 budget of 20 ms on an
//! M1). A measurement, not a test: it prints and asserts no time.
//!
//! `cargo test -p memry-desktop --release writeback_perf -- --ignored --nocapture`

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
