//! An outside writer that stalls inside its write (#4289): one that truncates the day's file and
//! writes it later (`open(O_TRUNC)`, stall, `write`), and one that writes in chunks (truncate,
//! first chunk, stall, the rest). The app renames its own file over the one it read, so a write
//! the writer makes after that lands in a file no path names. Typing wins, and the writer's
//! text is kept as a version (#4257 L1); the day keeps its frontmatter and its tags.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::journal::update::DayUpdate;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::hash::content_hash;
use serde_json::json;

use crate::index_support::until;
use crate::journal_update::{DAY, DAY_FILE, ID, made, opened, record, row_hash, update};
use crate::vault_env::Env;

const TYPED: &str = "Morning pages.\n\n- [ ] call Ann\n\nTyped in the app.";
const WRITTEN: &str = "Written outside.";

/// Past the watcher's debounce and the consumer's read, and short of
/// [`memry_desktop::vault::consumer::EMPTIED_SETTLE`].
const READ: Duration = Duration::from_millis(700);

/// The day's text as the outside writer writes it: the file with a line added.
fn outside_text(e: &Env) -> String {
    format!("{}\n\n{WRITTEN}\n", e.read(DAY_FILE).trim_end())
}

/// The writer's `open(O_TRUNC)`: the day's file is empty, and the writer holds it.
fn truncated(e: &Env) -> File {
    OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(e.vault.join(DAY_FILE))
        .unwrap()
}

fn save(e: &Env, notes: &NotesService) {
    let open = e.session.current().unwrap();
    // Refused or not: the outcome is what the file and the versions hold.
    let _ = notes.update_day(
        &open,
        DayUpdate {
            content: Some(TYPED.into()),
            ..update(DAY)
        },
    );
}

/// The day's document takes an edit its file does not have yet (a merge from sync).
fn body_ahead(e: &Env, store: &Arc<dyn SecureStore>) {
    let open = e.session.current().unwrap();
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: "Synced in.".into(),
        new_block_id: "b-synced".into(),
    };
    open.vault
        .journal(store.clone())
        .unwrap()
        .edit_day(DAY.into(), edit)
        .unwrap();
}

/// The writer's whole text is in the day's file or in one of its versions.
fn assert_kept(e: &Env, outside: &str) {
    until("the writer's text kept", || {
        e.read(DAY_FILE) == outside || e.versions(ID).iter().any(|v| v == outside)
    });
}

/// The rest of a chunked writer's text, written after the app replaced the file the writer
/// holds: it reaches a version, and the pages are told.
#[cfg(unix)]
fn write_rest_late(e: &mut Env, mut writer: File, rest: &str, outside: &str) {
    use memry_desktop::vault::consumer::Applied;

    // Facts of the replace itself are published right after it.
    std::thread::sleep(Duration::from_millis(300));
    e.drain();
    writer.write_all(rest.as_bytes()).unwrap();
    drop(writer);
    e.facts_until(|f| matches!(f, Applied::OutsideEditKept { note_id, .. } if note_id == ID));
    assert!(
        e.versions(ID).iter().any(|v| v == outside),
        "{:?}",
        e.versions(ID)
    );
}

fn assert_tags_kept(e: &Env) {
    assert_eq!(record(e).0, r#"["work","Ideas"]"#, "the day lost its tags");
    assert!(
        e.read(DAY_FILE).starts_with("---\n"),
        "{}",
        e.read(DAY_FILE)
    );
}

/// The CI failure of #4281 (linux-x64): the consumer reads the empty file before the save. Took
/// as the file, it let the save rename over the writer's open file.
#[test]
fn a_save_after_the_consumer_read_a_stalled_writers_empty_file_keeps_that_writers_text() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let outside = outside_text(&e);

    let mut writer = truncated(&e);
    std::thread::sleep(READ);
    save(&e, &notes);
    writer.write_all(outside.as_bytes()).unwrap();
    drop(writer);

    until("the typing written", || {
        e.read(DAY_FILE).contains("Typed in the app.")
    });
    assert_kept(&e, &outside);
    assert_tags_kept(&e);
}

/// A body ahead of the file wins over the empty file of a stalled writer: took as the file, the
/// write-back renamed over the writer's open file 500 ms later, and wrote the day without its
/// frontmatter.
#[test]
fn a_body_ahead_of_a_stalled_writers_empty_file_keeps_that_writers_text() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let outside = outside_text(&e);
    body_ahead(&e, &store);

    let mut writer = truncated(&e);
    std::thread::sleep(Duration::from_millis(1500));
    writer.write_all(outside.as_bytes()).unwrap();
    drop(writer);

    until("the body written", || {
        e.read(DAY_FILE).contains("Synced in.")
    });
    assert_kept(&e, &outside);
    assert_tags_kept(&e);
}

/// A file the user really emptied is no write in progress once it stayed empty: the consumer
/// takes it, and saves write over it. That it waits first is `consumer::tests::emptied`.
#[test]
fn an_empty_file_that_stays_empty_is_taken_once_it_settled() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let empty = content_hash("");

    fs::write(e.vault.join(DAY_FILE), "").unwrap();
    until("the empty file taken", || {
        row_hash(&e) == Some(empty.clone())
    });
    save(&e, &notes);
    assert!(
        e.read(DAY_FILE).contains("Typed in the app."),
        "{}",
        e.read(DAY_FILE)
    );
}

/// A save over a stalled writer's empty file is refused after the feed took its body, so a
/// property the save set is in neither the file nor the document: the save's whole text is
/// kept as a version.
#[test]
fn a_refused_save_over_an_emptied_file_keeps_the_property_it_set() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let open = e.session.current().unwrap();
    let outside = outside_text(&e);

    let mut writer = truncated(&e);
    let saved = notes.update_day(
        &open,
        DayUpdate {
            content: Some(TYPED.into()),
            properties: Some(json!({ "mood": "tired" }).as_object().unwrap().clone()),
            ..update(DAY)
        },
    );
    writer.write_all(outside.as_bytes()).unwrap();
    drop(writer);

    assert!(saved.is_err(), "{saved:?}");
    until("the typing written", || {
        e.read(DAY_FILE).contains("Typed in the app.")
    });
    let versions = e.versions(ID);
    assert!(
        versions
            .iter()
            .any(|v| v.contains("mood: tired") && v.contains("Typed in the app.")),
        "the save's text was lost: {versions:?}"
    );
}

/// The writer's first chunk, cut after the day's text: a whole frontmatter, part of the body.
#[cfg(unix)]
fn chunks(outside: &str) -> (&str, &str) {
    outside.split_at(outside.find(WRITTEN).unwrap())
}

/// A save over a chunked writer's first chunk renames over the file the writer still writes.
#[cfg(unix)]
#[test]
fn a_save_over_a_chunked_writers_first_chunk_keeps_that_writers_text() {
    let (mut e, notes, _) = opened();
    made(&mut e, &notes);
    let outside = outside_text(&e);
    let (first, rest) = chunks(&outside);

    let mut writer = truncated(&e);
    writer.write_all(first.as_bytes()).unwrap();
    save(&e, &notes);
    assert!(e.read(DAY_FILE).contains("Typed in the app."));

    write_rest_late(&mut e, writer, rest, &outside);
}

/// A body ahead of a chunked writer's first chunk wins, and the write-back renames over the file
/// the writer still writes.
#[cfg(unix)]
#[test]
fn a_body_ahead_of_a_chunked_writers_first_chunk_keeps_that_writers_text() {
    let (mut e, notes, store) = opened();
    made(&mut e, &notes);
    let outside = outside_text(&e);
    let (first, rest) = chunks(&outside);
    body_ahead(&e, &store);

    let mut writer = truncated(&e);
    writer.write_all(first.as_bytes()).unwrap();
    // The write-back renamed over the file the writer still holds.
    until("the body written", || {
        e.read(DAY_FILE).contains("Synced in.")
    });

    write_rest_late(&mut e, writer, rest, &outside);
}
