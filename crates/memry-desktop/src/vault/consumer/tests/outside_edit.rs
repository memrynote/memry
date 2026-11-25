//! Which changed files the identity is told about (`NoteIdentity::on_changed`, #3825): an outside
//! edit of the file the row named, once the document took it; never bytes the app wrote, nor a
//! file that only fills a body the row named no text of.

use std::sync::atomic::Ordering;

use memry_core::domain::journal;
use memry_core::storage::repositories::sync_items;
use memry_core::sync::apply::apply_pulled_delete;
use memry_core::sync::clock::{ClockOrder, VectorClock, compare};
use memry_core::sync::outbox;

use super::*;

fn told(f: &Fixture) -> Vec<(String, String)> {
    f.identity.changed.lock().unwrap().clone()
}

#[test]
fn an_outside_edit_of_the_file_the_row_named_is_told_with_that_files_hash() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    assert!(told(&f).is_empty(), "a new file is the adopt's");

    f.write("a.md", "---\ntags: [x]\n---\nfirst\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert_eq!(told(&f), [(id, content_hash("first\n"))]);
}

#[test]
fn bytes_a_save_wrote_are_not_told() {
    let mut f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    let saved = "---\ntags: [x]\n---\nsaved\n";
    f.write("a.md", saved);
    f.applier
        .own_files
        .wrote(&id, &content_hash(saved), ChangeSource::Save, None);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(told(&f).is_empty());
    assert!(matches!(
        f.facts().as_slice(),
        [Applied::Changed {
            source: ChangeSource::Save,
            ..
        }]
    ));
}

#[test]
fn a_file_that_fills_a_body_the_row_named_no_text_of_is_not_told() {
    let f = fixture();
    let id = f.note();
    f.rows
        .reserve(f.session(), &id, "a.md", Fixture::stat(0))
        .unwrap();
    f.write("a.md", "---\ntags: [x]\n---\nwritten\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(told(&f).is_empty());
}

/// The record did not take it: the row keeps naming the file it had, so the retry feeds the
/// same text, which the document answers `Unchanged`, and tells again.
#[test]
fn a_record_that_did_not_take_the_edit_retries_it() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.identity.changed_fails.store(true, Ordering::SeqCst);
    f.write("a.md", "---\ntags: [x]\n---\nfirst\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Retry("a.md".into()));
    let edited = content_hash("---\ntags: [x]\n---\nfirst\n");
    let row = f.row("a.md").unwrap();
    assert_eq!(row.content_hash, Some(content_hash("first\n")));
    assert_eq!(
        row.file_hash,
        Some(edited),
        "a move before the retry pairs on the bytes read"
    );

    f.identity.changed_fails.store(false, Ordering::SeqCst);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    let previous = content_hash("first\n");
    assert_eq!(told(&f), [(id.clone(), previous.clone()), (id, previous)]);
    assert_eq!(
        f.hash_of("a.md"),
        Some(content_hash("---\ntags: [x]\n---\nfirst\n"))
    );
}

/// A record that never takes it: the row moves on once the retries are spent, so it names the
/// file the document holds and the app's edits of that file are not refused.
#[test]
fn a_record_that_never_takes_the_edit_lets_the_row_move_on() {
    let mut f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    f.facts();
    f.identity.changed_fails.store(true, Ordering::SeqCst);
    let edited = "---\ntags: [x]\n---\nfirst\n";
    f.write("a.md", edited);
    for _ in 0..crate::vault::consumer::MAX_RETRIES {
        assert_eq!(f.changed(&id, "a.md"), Step::Retry("a.md".into()));
    }
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert_eq!(f.hash_of("a.md"), Some(content_hash(edited)));
    assert!(matches!(
        f.facts().as_slice(),
        [Applied::Changed {
            source: ChangeSource::Watcher,
            ..
        }]
    ));
}

/// The write-back tells an outside text replaced only for an outside edit the body did not take
/// (`body::outside_edit`, typing won): one the body took is its text (#4124), and bytes the app
/// wrote are its own.
#[test]
fn a_fed_outside_edit_and_an_own_write_are_not_recorded_for_the_write_back() {
    let f = fixture();
    f.write("a.md", "first\n");
    f.added("a.md");
    let id = only_note(&f, "a.md");
    let own = &f.applier.own_files;
    assert!(
        !own.is_outside(&id, &content_hash("first\n")),
        "the adopt's"
    );

    f.write("a.md", "edited outside\n");
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(!own.is_outside(&id, &content_hash("edited outside\n")));

    let saved = "saved\n";
    f.write("a.md", saved);
    own.wrote(&id, &content_hash(saved), ChangeSource::Save, None);
    assert_eq!(f.changed(&id, "a.md"), Step::Done);
    assert!(!own.is_outside(&id, &content_hash(saved)));
}

const DAY: &str = "journal/2025-01-17.md";
const SEEN: &str = "---\ntags: [work]\n---\nMorning pages.\n";
const EDITED: &str = "---\ntags: [work, idea]\n---\nMorning pages.\n\nWritten while closed.\n";

/// A journal day the app read and pushed, its file then edited (body and tags) while the app
/// was closed: the fixture over the real notes identity, the day's id and the clock it pushed.
fn closed_app_day() -> (Fixture, String, VectorClock) {
    closed_app_file(DAY, SEEN, EDITED, journal::ITEM_TYPE)
}

/// A file the app read and pushed as `item_type`, then edited while the app was closed.
fn closed_app_file(
    rel: &str,
    seen: &str,
    edited: &str,
    item_type: &'static str,
) -> (Fixture, String, VectorClock) {
    let mut f = fixture();
    let identity = crate::notes::identity::NotesIdentity::new(f.store.clone());
    f.applier = applier(&f.root, &f.vault, &f.store, &f.rows, identity);
    f.write(rel, seen);
    assert_eq!(f.walked(rel), Step::Done);
    let id = only_note(&f, rel);
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            let ids: Vec<i64> = conn
                .prepare("SELECT id FROM outbox")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            outbox::ack(conn, &ids).unwrap();
            Ok(())
        })
        .unwrap();
    let pushed = record(&f, item_type, &id).0;
    f.write(rel, edited);
    (f, id, pushed)
}

/// The day's record clock and what the outbox holds for it.
fn day_record(f: &Fixture, id: &str) -> (VectorClock, Vec<String>) {
    record(f, journal::ITEM_TYPE, id)
}

/// The record's clock and what the outbox holds for it.
fn record(f: &Fixture, item_type: &'static str, id: &str) -> (VectorClock, Vec<String>) {
    let id = id.to_owned();
    f.vault
        .db_handle()
        .call_blocking(move |conn| {
            let row = sync_items::load(conn, item_type, &id)?.expect("the record");
            let clock = serde_json::from_str(&row.clock.expect("a clock")).unwrap();
            let ops = conn
                .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
                .unwrap()
                .query_map([&id], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap();
            Ok((clock, ops))
        })
        .unwrap()
}

/// A peer that saw the day as pushed deletes it an hour later: its clock is the pushed one and
/// its own tick, and its stamp is past every slack the keep rule gives a recent local edit.
fn peer_deletes(f: &Fixture, id: &str, pushed: &VectorClock) {
    peer_deletes_item(f, journal::ITEM_TYPE, id, pushed);
}

fn peer_deletes_item(f: &Fixture, item_type: &'static str, id: &str, pushed: &VectorClock) {
    let hour_later = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
        + 3_600_000;
    let mut clock = pushed.clone();
    clock.insert("peer".into(), 1);
    let device = pushed.keys().next().expect("this device's tick").clone();
    let (id, root) = (id.to_owned(), f.root.clone());
    f.vault
        .db_handle()
        .call_blocking(move |conn| {
            apply_pulled_delete(
                conn, item_type, &id, hour_later, &clock, hour_later, &device, &root,
            )
        })
        .unwrap();
}

fn kept_texts(f: &Fixture) -> Vec<String> {
    f.vault
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .prepare("SELECT content FROM inbox_items")
                .unwrap()
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap())
        })
        .unwrap()
}

/// #5758: a day edited while the app was closed is told to its record by the open walk, which
/// ticks the day's clock and queues it, tags and all, so a peer's concurrent delete still wins
/// but keeps the edited text as an inbox copy.
#[test]
fn a_closed_app_journal_edit_ticks_the_day_and_a_concurrent_delete_keeps_its_text() {
    let (f, id, pushed) = closed_app_day();
    assert_eq!(f.walked(DAY), Step::Done);
    let (clock, ops) = day_record(&f, &id);
    assert_eq!(
        compare(&clock, &pushed),
        ClockOrder::After,
        "the edit ticks the day"
    );
    assert!(
        ops.iter().any(|op| op == "upsert"),
        "the record is queued: {ops:?}"
    );
    assert!(
        ops.iter().any(|op| op == "crdt-update"),
        "the body is queued: {ops:?}"
    );

    peer_deletes(&f, &id, &pushed);
    let kept = kept_texts(&f);
    assert_eq!(kept.len(), 1, "one inbox copy: {kept:?}");
    assert!(kept[0].contains("Written while closed."), "{kept:?}");
}

/// #5758, the first pull before the open walk: the peer's delete lands while the day's record
/// still holds the clock it pushed and nothing is queued, so the delete wins on the clock
/// alone. The text the file holds, which the document never took, is kept as an inbox copy.
#[test]
fn a_delete_pulled_before_the_walk_sees_a_closed_app_journal_edit_keeps_its_text() {
    let (f, id, pushed) = closed_app_day();
    peer_deletes(&f, &id, &pushed);
    let kept = kept_texts(&f);
    assert_eq!(kept.len(), 1, "one inbox copy: {kept:?}");
    assert!(kept[0].contains("Written while closed."), "{kept:?}");
}

/// #5796, a note edited while the app was closed: the peer's delete lands before the walk reads
/// the edit, so no clock, outbox entry or body log here knows of it. The delete wins and the
/// file's text is kept as one inbox copy; a later walk of the same edit makes no second one.
#[test]
fn a_delete_pulled_before_the_walk_sees_a_closed_app_note_edit_keeps_its_text() {
    let (f, id, pushed) = closed_app_file(
        "a.md",
        "first\n",
        "first\n\nWritten while closed.\n",
        "note",
    );
    peer_deletes_item(&f, "note", &id, &pushed);
    let kept = kept_texts(&f);
    assert_eq!(kept.len(), 1, "one inbox copy: {kept:?}");
    assert!(kept[0].contains("Written while closed."), "{kept:?}");
    let deleted = |f: &Fixture| {
        let id = id.clone();
        f.vault
            .db_handle()
            .call_blocking(
                move |conn| Ok(sync_items::load(conn, "note", &id)?.expect("the record")),
            )
            .unwrap()
            .deleted_at
            .is_some()
    };
    assert!(deleted(&f), "the delete wins");

    f.walked("a.md");
    assert_eq!(kept_texts(&f).len(), 1, "a later walk keeps no second copy");
    assert!(deleted(&f), "a later walk does not revive the note");
}
