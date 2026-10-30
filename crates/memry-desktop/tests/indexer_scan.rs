//! The note index (Step 13e) over a real session, tier and watcher: a generated vault of 1000
//! notes is measured into `note_stats` once per note, a reindex reports monotonic progress that
//! ends at the total, and live facts (an app write, a removal, lost facts) keep the rows current.
//!
//! The times print with `--nocapture`; no normal test asserts one. The budgets of #3530 (tier 0
//! under 400 ms, `notes_list` under 15 ms) are asserted by the ignored release run:
//!
//! ```text
//! cargo test -p memry-desktop --release --test indexer_scan -- --ignored --nocapture
//! ```

mod device_key;
mod vault_env;

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use memry_core::domain::note_stats::measure;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::index::{Backfilled, IndexProgress, Indexer, NoteIndex};
use memry_desktop::session::projection::CancelToken;
use memry_desktop::vault::consumer::Applied;
use memry_desktop::vault::consumer::rows::RowStat;
use memry_desktop::vault::file_types::FileType;
use memry_desktop::vault::hash::content_hash;
use vault_env::{Env, WAIT, env, indexed};

const NOTES: usize = 1000;

fn note_text(i: usize) -> String {
    let mut text = String::new();
    if i.is_multiple_of(3) {
        text.push_str(&format!("---\ntags:\n  - topic{}\n  - Shared\n", i % 7));
        if i.is_multiple_of(5) {
            text.push_str("cover: wash:sage\n");
        }
        text.push_str("---\n");
    }
    text.push_str(&format!(
        "# Note {i}\n\nSome words about note {i} and [[Note {}]].\n",
        i + 1
    ));
    if i.is_multiple_of(4) {
        text.push_str("```\nlet skipped = true\n```\n");
    }
    if i.is_multiple_of(6) {
        text.push_str(&format!("- [ ] a task {{task:t{i}}}\n"));
    }
    text
}

fn path_of(i: usize) -> String {
    format!("f{}/Note {i}.md", i % 10)
}

/// A vault of `count` notes with their records and rows, as a closed app leaves it.
fn seeded(count: usize) -> (Env, Arc<dyn SecureStore>, Vec<(String, String)>) {
    let store = Mutex::new(None);
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s);
        None
    });
    let store = store.into_inner().unwrap().unwrap();
    for i in 0..count {
        e.write(&path_of(i), &note_text(i));
    }
    e.open();
    let core = e.core();
    let writer = core.notes_writer(store.clone()).unwrap();
    let rows = e.tier.rows();
    let session = rows.session_for(&core).unwrap();
    let mut notes = Vec::new();
    for i in 0..count {
        let (path, text) = (path_of(i), note_text(i));
        let id = writer
            .create(format!("Note {i}"), Some(format!("f{}", i % 10)))
            .unwrap();
        let hash = content_hash(&text);
        // Both hashes name the file, as an indexed vault's rows do, so the open walk reads
        // nothing: what is measured below is the index alone.
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(hash.clone()),
            file_hash: Some(hash),
        };
        rows.reserve(session, &id, &path, stat).unwrap();
        notes.push((id, path));
    }
    e.close();
    (e, store, notes)
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "still waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn all_indexed(e: &Env) -> bool {
    let search = e.session.current().expect("open").search;
    search.unindexed_notes(false).unwrap().is_empty()
}

struct Measured {
    tier0: Duration,
    tier1: Duration,
    notes_list: Duration,
}

/// Opens the seeded vault with the index and times the open walk (tier 0), the backfill
/// (tier 1) and the sidebar list.
fn open_and_measure(e: &mut Env) -> (Arc<NoteIndex>, Measured) {
    let index = NoteIndex::new(e.tier.clone());
    index.register(&e.session);
    e.drain();
    let started = Instant::now();
    e.open();
    e.facts_until(indexed);
    let tier0 = started.elapsed();
    until("every note measured", || all_indexed(e));
    let tier1 = started.elapsed();
    let listed_at = Instant::now();
    let listed = e.core().notes().list().unwrap();
    let notes_list = listed_at.elapsed();
    assert_eq!(listed.len(), NOTES);
    println!(
        "{NOTES} notes: tier 0 {tier0:?}, tier 1 {tier1:?}, notes_list {notes_list:?} ({} build)",
        if cfg!(debug_assertions) {
            "debug"
        } else {
            "release"
        }
    );
    (
        index,
        Measured {
            tier0,
            tier1,
            notes_list,
        },
    )
}

#[test]
fn a_generated_vault_is_measured_once_per_note_and_a_reindex_reports_to_the_total() {
    let (mut e, _store, notes) = seeded(NOTES);
    let (index, _) = open_and_measure(&mut e);

    let search = e.session.current().unwrap().search;
    for (i, (id, _)) in notes.iter().enumerate() {
        let stored = search.note_stats(id).unwrap().expect("a row");
        assert_eq!(stored.stats, measure(&note_text(i)), "{id}");
        assert_eq!(stored.file_hash, Some(content_hash(&note_text(i))));
        assert_eq!(stored.date, None);
    }

    let mut steps: Vec<IndexProgress> = Vec::new();
    let done = index.reindex(|step| steps.push(step)).unwrap();
    // Every file read once, written in one core call per batch of 200.
    assert_eq!(
        done,
        Backfilled {
            listed: NOTES,
            indexed: NOTES,
            skipped: 0,
            writes: NOTES.div_ceil(200),
        }
    );
    assert_eq!(
        steps.first(),
        Some(&IndexProgress {
            built: 0,
            total: NOTES
        })
    );
    assert_eq!(
        steps.last(),
        Some(&IndexProgress {
            built: NOTES,
            total: NOTES
        })
    );
    assert!(
        steps.windows(2).all(|w| w[0].built < w[1].built),
        "{steps:?}"
    );
    e.close();
}

#[test]
fn facts_keep_the_rows_current_and_lost_facts_run_a_scan() {
    let (mut e, _store, notes) = seeded(3);
    let index = NoteIndex::new(e.tier.clone());
    index.register(&e.session);
    e.drain();
    e.open();
    e.facts_until(indexed);
    until("the seeded notes measured", || all_indexed(&e));
    let open = e.session.current().unwrap();
    let rows = e.tier.rows();
    let session = rows.session_for(&open.vault).unwrap();

    // An app write: the new text is measured once the queue is due. The end of the walk
    // asked for a scan, which may measure the first write; it is done once the first write
    // is measured, so only the write's own fact can measure the second.
    let (id, path) = &notes[0];
    for text in [
        "---\ntags: [fresh]\n---\nfour words right here\n",
        "then five other words here\n- [ ] and a task {task:t9}\n",
    ] {
        // Told to the own-write record first, as the app does: the watcher reports nothing.
        e.tier.echo().will_write(path, &content_hash(text));
        e.write(path, text);
        let stat = RowStat {
            file_type: FileType::Markdown,
            size: text.len() as u64,
            content_hash: Some(content_hash(text)),
            file_hash: Some(content_hash(text)),
        };
        rows.record_write(session, id, path, stat).unwrap();
        until("the write measured", || {
            open.search.note_stats(id).unwrap().unwrap().stats == measure(text)
        });
    }

    // A removal drops the row.
    let (gone, _) = &notes[1];
    assert!(rows.remove(session, gone).unwrap());
    until("the removed note's row dropped", || {
        open.search.note_stats(gone).unwrap().is_none()
    });

    // Facts lost to a lagged subscription: the indexer scans and measures what has no row.
    let (lost, _) = &notes[2];
    assert!(open.search.forget_note_stats(lost).unwrap());
    let (sender, receiver) = tokio::sync::broadcast::channel(1);
    // Facts that ask for no scan themselves: only the lag can.
    for _ in 0..3 {
        let none = Applied::Removed {
            note_id: "no-such-note".into(),
            path: "none.md".into(),
        };
        sender.send(none).unwrap();
    }
    let indexer = Indexer::new(&open);
    let cancel = CancelToken::default();
    std::thread::scope(|scope| {
        scope.spawn(|| indexer.run(receiver, &cancel));
        // Cancelled on the way out, a failed wait included, so the scope can join the task.
        let _stop = CancelOnDrop(&cancel);
        until("the lost note measured", || {
            open.search.note_stats(lost).unwrap().is_some()
        });
    });
    e.close();
}

struct CancelOnDrop<'a>(&'a CancelToken);

impl Drop for CancelOnDrop<'_> {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// The #3530 budgets, in a release build: `cargo test --release ... -- --ignored`.
#[test]
#[ignore = "a release-build measurement"]
fn the_open_walk_and_the_sidebar_list_meet_their_budgets() {
    let (mut e, _store, _) = seeded(NOTES);
    let (_, measured) = open_and_measure(&mut e);
    // timing-bound: the #3530 budget, asserted only by this ignored release-build run.
    assert!(
        measured.tier0 < Duration::from_millis(400),
        "{:?}",
        measured.tier0
    );
    // timing-bound: the #3530 budget, asserted only by this ignored release-build run.
    assert!(
        measured.notes_list < Duration::from_millis(15),
        "{:?}",
        measured.notes_list
    );
    println!("tier 1 took {:?}", measured.tier1);
    e.close();
}
