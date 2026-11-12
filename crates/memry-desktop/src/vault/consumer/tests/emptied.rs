//! A note's file read empty over a row that names other bytes: an outside writer between its
//! truncate and its write (#4289). The fact waits until the file settled, and the row keeps
//! naming the file it named.

use std::time::{Duration, Instant};

use super::*;
use crate::vault::consumer::EMPTIED_SETTLE;
use crate::vault::consumer::body::{EMPTIED_STALE, Emptied};

const TEXT: &str = "first words\n";

/// A note at `n.md` whose file was just emptied.
fn emptied(f: &Fixture) -> String {
    f.write("n.md", TEXT);
    assert_eq!(f.added("n.md"), Step::Done);
    f.write("n.md", "");
    only_note(f, "n.md")
}

fn assert_waits(f: &Fixture, step: Step, read_at: Instant) {
    let Step::Wait(path, until) = step else {
        panic!("taken before it settled: {step:?}");
    };
    assert_eq!(path, "n.md");
    assert!(until >= read_at + EMPTIED_SETTLE, "{until:?}");
    assert_eq!(f.hash_of("n.md"), Some(content_hash(TEXT)));
}

#[test]
fn a_file_read_empty_waits_to_settle_and_keeps_its_row() {
    let f = fixture();
    let id = emptied(&f);
    let read_at = Instant::now();
    assert_waits(&f, f.changed(&id, "n.md"), read_at);
}

/// A wait the consumer left long ago (the file was refilled, moved or removed since) is no
/// settle of this read: it waits again.
#[test]
fn an_empty_read_long_after_the_last_waits_again() {
    let f = fixture();
    let id = emptied(&f);
    let long_ago = Instant::now() - EMPTIED_STALE - Duration::from_millis(1);
    f.applier.emptied.lock().unwrap().insert(
        id.clone(),
        Emptied {
            since: long_ago,
            seen: long_ago,
        },
    );
    let read_at = Instant::now();
    assert_waits(&f, f.changed(&id, "n.md"), read_at);
}
