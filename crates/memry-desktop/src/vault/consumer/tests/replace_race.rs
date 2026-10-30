//! Windows answers a note's name as missing for an instant while another program renames a new
//! file over it (#3732). A consumer read in that instant is retried, never applied as done
//! (#3736): the watcher does not report the same bytes twice, so a save read as missing and
//! taken for done never reached the note. The retry itself is tested on every OS, without a
//! race (`facts::a_notes_file_missing_when_it_is_read_is_retried_and_the_retry_takes_the_save`);
//! this is the stress run on a real rename storm, a VM proof run by hand.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use super::*;
use crate::vault::note_file::read_note;

/// Another program saves the note thousands of times a second, always the same bytes, far more
/// often than any editor. Before each read the row is set back to the older file, so every read
/// that is applied takes the save. A read that ends `Done` must leave the row naming the save.
/// Each read is preceded by a plain read of the file, which counts the reads that found the
/// name missing; the test fails when no read raced a replacement at all, so it cannot pass for
/// want of a race. Whether reads race depends on the machine: on a Windows 11 ARM64 VM about a
/// third of 5000 did, and one plain read in 200 found the name missing; on the hosted CI runners
/// (windows-2022, windows-11-arm) none of 500 did. So it is ignored in CI. Run it on the VM:
/// `memry_desktop-*.exe replace_race --ignored --nocapture` (a `cargo xwin test --no-run` build;
/// `MEMRY_REPLACE_READS` changes the 5000 reads).
#[test]
#[ignore = "a race that only some Windows machines produce: a VM proof, run by hand"]
fn a_note_read_while_it_is_renamed_over_is_retried_never_done_unread() {
    let f = fixture();
    f.write("n.md", "first words\n");
    assert_eq!(f.added("n.md"), Step::Done);
    let id = only_note(&f, "n.md");
    let first = content_hash("first words\n");
    let saved = "saved outside\n";
    let stop = Arc::new(AtomicBool::new(false));
    let saver = {
        let (stop, note) = (stop.clone(), f.root.join("n.md"));
        std::thread::spawn(move || {
            let side = note.with_extension("md.save");
            let mut saves = 0u64;
            while !stop.load(Ordering::Relaxed) {
                // A save the file system refuses for an instant is tried again, as editors do.
                if std::fs::write(&side, saved)
                    .and_then(|()| std::fs::rename(&side, &note))
                    .is_ok()
                {
                    saves += 1;
                }
            }
            saves
        })
    };
    // Reads start once the older file is replaced: a read of that one is done without the save.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    while !matches!(read_note(&f.root, "n.md"), Ok(Some(file)) if file.raw == saved) {
        assert!(
            std::time::Instant::now() < deadline,
            "the first save never landed"
        );
        std::thread::yield_now();
    }
    let reads: u64 = std::env::var("MEMRY_REPLACE_READS")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(5_000);
    let (mut raw_missing, mut retried, mut done_unread) = (0u64, 0u64, 0u64);
    for _ in 0..reads {
        if matches!(read_note(&f.root, "n.md"), Ok(None)) {
            raw_missing += 1;
        }
        let older = RowStat {
            content_hash: Some(first.clone()),
            ..Fixture::stat(0)
        };
        f.rows
            .lane_of(f.session())
            .unwrap()
            .put(&id, "n.md", older)
            .unwrap();
        let changed = VaultEvent::Changed {
            note_id: id.clone(),
            path: "n.md".into(),
            content_hash: None,
            size: 0,
            modified_ms: i64::MAX,
        };
        match f.applier.apply(changed) {
            Step::Retry(_) => retried += 1,
            Step::Done if f.hash_of("n.md") != Some(content_hash(saved)) => done_unread += 1,
            Step::Done => {}
        }
    }
    stop.store(true, Ordering::Relaxed);
    let saves = saver.join().unwrap();
    eprintln!(
        "reads={reads} saves={saves} raw_missing={raw_missing} retried={retried} \
         done_unread={done_unread}"
    );
    // A read that found the name missing, or failed on the file being replaced, raced a save.
    assert!(
        raw_missing + retried > 0,
        "no read raced a replacement: the race never happened"
    );
    assert_eq!(
        done_unread, 0,
        "{reads} reads during {saves} saves: a save read as missing was taken for done"
    );
}
