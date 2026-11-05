//! The notes identity (Steps 13d and 13m, #3530) under the vault tier: a session opens a vault,
//! the watcher reports, the consumer asks `NotesIdentity` which note or journal day each file
//! is. The record rules are `memry-core`'s `tests/domain_note_identity.rs` and
//! `tests/domain_journal_day_identity.rs`; these cover what only the running tier
//! shows: rows, bodies and ids across opens, and a vault Electron wrote
//! (`tests/fixtures/electron-vault`, captured by `scripts/electron-fixtures/capture-vault.mjs`).

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::collections::BTreeMap;
use std::fs;
use std::io::Read as _;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use flate2::read::GzDecoder;
use memry_core::crdt::update_log::LOCAL_NAMESPACE_PREFIX;
use memry_core::domain::note_positions;
use memry_core::domain::notes::identity::VAULT_ORIGIN_META_KEY;
use memry_core::markdown::convert::api::Converter;
use memry_core::markdown::schema::callout_types::CalloutTypes;
use memry_core::seams::secure_store::SecureStore;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use memry_desktop::vault::hash::content_hash;
use rusqlite::OptionalExtension as _;
use serde_json::Value;
use vault_env::{Env, env, indexed};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/electron-vault");

fn notes_env() -> Env {
    env(|store| Some(NotesIdentity::new(store)))
}

/// [`notes_env`], with the device's key store for edits made in the app.
fn notes_env_with_store() -> (Env, Arc<dyn SecureStore>) {
    let mut kept = None;
    let e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    (e, kept.expect("the store"))
}

fn owes_file_body(e: &Env, id: &str) -> bool {
    e.core().note_files().owes_file_body(id).unwrap()
}

/// Waits until `holds`, a state the tier reaches, for up to [`vault_env::WAIT`]: a stalled
/// watcher or consumer only makes it later, never false.
fn until(what: &str, holds: impl Fn() -> bool) {
    let deadline = std::time::Instant::now() + vault_env::WAIT;
    while !holds() {
        assert!(std::time::Instant::now() < deadline, "never: {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The note's row names `text` as the bytes on disk and as what its document holds.
fn row_holds(e: &Env, id: &str, text: &str) -> bool {
    let row = e.core().note_files().by_id(id).unwrap();
    let hash = Some(content_hash(text));
    row.is_some_and(|row| row.content_hash == hash && row.file_hash == hash)
}

/// The note's row stays and names no bytes: its file went and the note was kept.
fn row_kept_without_hashes(e: &Env, id: &str) -> bool {
    let row = e.core().note_files().by_id(id).unwrap();
    let row = row.expect("the removal deleted the note");
    row.content_hash.is_none() && row.file_hash.is_none()
}

/// The manual slot of `path`, if it has one.
fn slot(e: &Env, path: &str) -> Option<i64> {
    let path = path.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT position FROM note_positions WHERE path = ?1",
                    [path],
                    |row| row.get(0),
                )
                .optional()
                .unwrap())
        })
        .unwrap()
}

/// The records owed a move of their file, by id, read from the table itself: a debt whose row
/// is gone must not be there.
fn owed(e: &Env) -> Vec<String> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT note_id FROM note_place_owed ORDER BY note_id")
                .unwrap();
            Ok(statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// `(id, date, deleted)` of every journal entry, by id.
fn days(e: &Env) -> Vec<(String, String, bool)> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT id, date, deleted_at IS NOT NULL FROM journal_entries ORDER BY id")
                .unwrap();
            Ok(statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// `(id, title, folder_path, deleted)` of every note record, by id.
fn records(e: &Env) -> Vec<(String, String, Option<String>, bool)> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare(
                    "SELECT id, title, folder_path, deleted_at IS NOT NULL FROM notes ORDER BY id",
                )
                .unwrap();
            Ok(statement
                .query_map([], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// `(op, item_id)` of every queued row.
fn outbox(e: &Env) -> Vec<(String, String)> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            let mut statement = conn
                .prepare("SELECT op, item_id FROM outbox ORDER BY id")
                .unwrap();
            Ok(statement
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap())
        })
        .unwrap()
}

/// What the open that created the core recorded it was created over.
fn origin(e: &Env) -> Option<String> {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            Ok(conn
                .query_row(
                    "SELECT value FROM meta WHERE key = ?1",
                    [VAULT_ORIGIN_META_KEY],
                    |row| row.get(0),
                )
                .optional()
                .unwrap())
        })
        .unwrap()
}

/// How many edits the note's record has had: the sum of its vector clock.
fn clock_ticks(e: &Env, id: &str) -> i64 {
    let id = id.to_owned();
    let payload = e
        .core()
        .db_handle()
        .call_blocking(move |conn| sync_items::push_payload(conn, "note", &id))
        .unwrap()
        .unwrap();
    let payload: Value = serde_json::from_str(&payload).unwrap();
    payload["clock"]
        .as_object()
        .unwrap()
        .values()
        .map(|tick| tick.as_i64().unwrap())
        .sum()
}

/// The content hash the row of `path` holds.
fn row_hash(e: &Env, path: &str) -> Option<String> {
    let path = path.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT content_hash FROM note_files WHERE path = ?1",
                    [path],
                    |row| row.get::<_, Option<String>>(0),
                )
                .unwrap())
        })
        .unwrap()
}

fn row_id(e: &Env, path: &str) -> Option<String> {
    e.rows()
        .into_iter()
        .find(|(_, p)| p == path)
        .map(|(id, _)| id)
}

fn added(path: &'static str) -> impl Fn(&Applied) -> bool {
    move |fact| matches!(fact, Applied::Added { path: p, .. } if p == path)
}

fn reopen(e: &mut Env) -> Vec<Applied> {
    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed)
}

/// A file whose path names a day is that day's entry; any other file is a note, one under the
/// journal folder included (`newMarkdownFileId`).
#[test]
fn the_vaults_files_become_notes_and_days_and_a_reopen_names_none_again() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.write("journal/b.md", "Beta\n");
    e.write("journal/2025-01-01.md", "A day\n");
    fs::write(e.vault.join("pic.png"), [0x89, b'P', b'N', b'G']).unwrap();
    // Large-file class: one block over 128 KiB. Electron never syncs it.
    e.write("big.md", &"x".repeat(200 * 1024));
    e.open();
    let facts = e.facts_until(indexed);
    assert_eq!(origin(&e).as_deref(), Some("native"));
    for path in ["a.md", "journal/b.md", "journal/2025-01-01.md"] {
        assert!(
            facts
                .iter()
                .any(|f| matches!(f, Applied::Added { path: p, created: true, .. } if p == path)),
            "{path}: {facts:?}"
        );
    }
    let (a, b) = (
        row_id(&e, "a.md").unwrap(),
        row_id(&e, "journal/b.md").unwrap(),
    );
    assert_eq!(
        row_id(&e, "journal/2025-01-01.md").as_deref(),
        Some("j2025-01-01")
    );
    assert_eq!(e.rows().len(), 3, "{:?}", e.rows());
    let mut want = vec![
        (a.clone(), "a".to_owned(), None, false),
        (b.clone(), "b".to_owned(), Some("journal".to_owned()), false),
    ];
    want.sort();
    assert_eq!(records(&e), want);
    let day = vec![("j2025-01-01".to_owned(), "2025-01-01".to_owned(), false)];
    assert_eq!(days(&e), day);
    assert_eq!(e.body(&a), "Alpha");
    assert_eq!(e.body(&b), "Beta");
    assert_eq!(e.body("j2025-01-01"), "A day");

    let facts = reopen(&mut e);
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Added { .. })),
        "{facts:?}"
    );
    assert_eq!(records(&e), want);
    assert_eq!(days(&e), day);
    assert_eq!(e.body(&a), "Alpha");
}

/// A day's file the journal format change moves keeps its day (`renameKeepsJournalDate`). One
/// moved to another day's path is that day now, as Electron re-creates it: the old day is
/// deleted, pushed once, and the new one made from the file. A day file removed deletes its day
/// once (`enqueueJournalDelete`).
#[test]
fn a_day_keeps_its_record_through_a_move_and_its_removal_deletes_it() {
    let mut e = notes_env();
    e.write("journal/2025-01-01.md", "A day\n");
    e.write("journal/2025-01-03.md", "Another day\n");
    e.open();
    e.facts_until(indexed);
    let queued = outbox(&e);
    e.close();

    e.write(
        ".memry/config.json",
        r#"{"journalFolder": "journal", "journalDateFormat": "YYYY/YYYY-MM-DD"}"#,
    );
    fs::create_dir_all(e.vault.join("journal/2025")).unwrap();
    for day in ["01", "03"] {
        fs::rename(
            e.vault.join(format!("journal/2025-01-{day}.md")),
            e.vault.join(format!("journal/2025/2025-01-{day}.md")),
        )
        .unwrap();
    }
    reopen(&mut e);
    assert_eq!(
        row_id(&e, "journal/2025/2025-01-01.md").as_deref(),
        Some("j2025-01-01")
    );
    let live = |date: &str| (format!("j{date}"), date.to_owned(), false);
    let gone = |date: &str| (format!("j{date}"), date.to_owned(), true);
    assert_eq!(days(&e), vec![live("2025-01-01"), live("2025-01-03")]);
    assert_eq!(outbox(&e), queued);
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));
    e.close();

    fs::rename(
        e.vault.join("journal/2025/2025-01-01.md"),
        e.vault.join("journal/2025/2025-01-02.md"),
    )
    .unwrap();
    let facts = reopen(&mut e);
    assert!(
        facts.iter().any(|f| matches!(
            f,
            Applied::Removed { note_id, path, .. }
                if note_id == "j2025-01-01" && path == "journal/2025/2025-01-01.md"
        )),
        "{facts:?}"
    );
    assert!(
        facts.iter().any(|f| matches!(
            f,
            Applied::Added { note_id, created: true, .. } if note_id == "j2025-01-02"
        )),
        "{facts:?}"
    );
    assert_eq!(
        row_id(&e, "journal/2025/2025-01-02.md").as_deref(),
        Some("j2025-01-02")
    );
    assert_eq!(
        days(&e),
        vec![gone("2025-01-01"), live("2025-01-02"), live("2025-01-03")]
    );
    assert_eq!(e.body("j2025-01-02"), "A day");
    let pushed = outbox(&e);
    assert!(
        pushed.contains(&("delete".to_owned(), "j2025-01-01".to_owned())),
        "{pushed:?}"
    );
    assert!(
        pushed.contains(&("upsert".to_owned(), "j2025-01-02".to_owned())),
        "{pushed:?}"
    );
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));

    fs::remove_file(e.vault.join("journal/2025/2025-01-03.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if note_id == "j2025-01-03"));
    assert_eq!(
        days(&e),
        vec![gone("2025-01-01"), live("2025-01-02"), gone("2025-01-03")]
    );
    let deletes = |e: &Env| {
        outbox(e)
            .into_iter()
            .filter(|(op, _)| op == "delete")
            .count()
    };
    assert_eq!(deletes(&e), 2, "{:?}", outbox(&e));
    reopen(&mut e);
    assert_eq!(deletes(&e), 2, "{:?}", outbox(&e));
}

#[test]
fn a_file_moved_while_closed_keeps_its_note_and_the_record_follows() {
    let mut e = notes_env();
    e.write("dir/b.md", "Beta\n");
    e.open();
    e.facts_until(added("dir/b.md"));
    e.facts_until(indexed);
    let id = row_id(&e, "dir/b.md").unwrap();
    e.close();

    fs::rename(e.vault.join("dir/b.md"), e.vault.join("c.md")).unwrap();
    let facts = reopen(&mut e);
    assert!(
        facts.iter().any(
            |f| matches!(f, Applied::Renamed { note_id, new_path, .. } if *note_id == id && new_path == "c.md")
        ),
        "{facts:?}"
    );
    assert_eq!(e.rows(), vec![(id.clone(), "c.md".to_owned())]);
    assert_eq!(records(&e), vec![(id.clone(), "c".to_owned(), None, false)]);
    assert_eq!(e.body(&id), "Beta");
}

/// A note moved to a day's path is that day now, and a day moved out of the journal a note:
/// Electron deletes the item the file was and lists the file as a new one (`watcher.ts`, "Move
/// changes the file between note and journal"), since notes and days are separate sync types
/// keyed by id. Both the delete and the new item are pushed.
#[test]
fn a_move_between_note_and_day_deletes_the_item_and_makes_a_new_one() {
    let mut e = notes_env();
    e.write("2025-01-02.md", "A day to be\n");
    e.open();
    e.facts_until(added("2025-01-02.md"));
    e.facts_until(indexed);
    let id = row_id(&e, "2025-01-02.md").unwrap();
    e.close();

    fs::create_dir_all(e.vault.join("journal")).unwrap();
    fs::rename(
        e.vault.join("2025-01-02.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    reopen(&mut e);
    assert_eq!(
        records(&e),
        vec![(id.clone(), "2025-01-02".to_owned(), None, true)]
    );
    assert_eq!(
        days(&e),
        vec![("j2025-01-02".to_owned(), "2025-01-02".to_owned(), false)]
    );
    assert_eq!(
        row_id(&e, "journal/2025-01-02.md").as_deref(),
        Some("j2025-01-02")
    );
    assert_eq!(e.body("j2025-01-02"), "A day to be");
    assert!(outbox(&e).contains(&("delete".to_owned(), id.clone())));
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));

    // The watcher pairs the file's next edit with the new day, not the deleted note.
    e.write("journal/2025-01-02.md", "A day to be, edited\n");
    until("the edit reached the day", || {
        e.body("j2025-01-02") == "A day to be, edited"
    });

    // Live this time: the watcher's move.
    fs::create_dir_all(e.vault.join("Notes")).unwrap();
    fs::rename(
        e.vault.join("journal/2025-01-02.md"),
        e.vault.join("Notes/2025-01-02.md"),
    )
    .unwrap();
    e.facts_until(added("Notes/2025-01-02.md"));
    let note = row_id(&e, "Notes/2025-01-02.md").unwrap();
    assert_ne!(note, id);
    assert_eq!(
        days(&e),
        vec![("j2025-01-02".to_owned(), "2025-01-02".to_owned(), true)]
    );
    assert!(records(&e).contains(&(
        note.clone(),
        "2025-01-02".to_owned(),
        Some("Notes".to_owned()),
        false
    )));
    assert_eq!(e.body(&note), "A day to be, edited");
    assert!(outbox(&e).contains(&("delete".to_owned(), "j2025-01-02".to_owned())));
}

/// A crossing move whose note has text its file never had (here a body the file is behind)
/// keeps the note, owed the move, as a removal would: a delete would take that text from every
/// device.
#[test]
fn a_crossing_move_of_a_note_its_file_does_not_hold_keeps_it_owed() {
    let mut e = notes_env();
    e.write("grow.md", "Small\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "grow.md").unwrap();
    e.write("grow.md", &"x".repeat(200 * 1024));
    until("the large text owes the file body", || {
        owes_file_body(&e, &id)
    });
    e.drain();
    let queued = outbox(&e);

    fs::create_dir_all(e.vault.join("journal")).unwrap();
    fs::rename(
        e.vault.join("grow.md"),
        e.vault.join("journal/2025-01-04.md"),
    )
    .unwrap();
    e.facts_until(
        |f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "journal/2025-01-04.md"),
    );
    assert_eq!(
        records(&e),
        vec![(id.clone(), "grow".to_owned(), None, false)]
    );
    assert!(days(&e).is_empty());
    assert_eq!(owed(&e), vec![id.clone()]);
    assert_eq!(outbox(&e), queued);
}

/// A crossing move owed while the journal days were unknown is made at the next open that
/// reads the config: the note deleted, the day new.
#[test]
fn a_crossing_move_owed_is_made_at_the_next_open() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md").unwrap();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    fs::create_dir_all(e.vault.join("journal")).unwrap();
    fs::rename(e.vault.join("a.md"), e.vault.join("journal/2025-01-05.md")).unwrap();
    e.facts_until(
        |f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "journal/2025-01-05.md"),
    );
    assert_eq!(owed(&e), vec![id.clone()]);
    e.close();

    e.write(".memry/config.json", "{}");
    reopen(&mut e);
    assert_eq!(records(&e), vec![(id.clone(), "a".to_owned(), None, true)]);
    assert_eq!(
        days(&e),
        vec![("j2025-01-05".to_owned(), "2025-01-05".to_owned(), false)]
    );
    assert_eq!(
        row_id(&e, "journal/2025-01-05.md").as_deref(),
        Some("j2025-01-05")
    );
    assert_eq!(e.body("j2025-01-05"), "Alpha");
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));
}

/// A move while the vault config cannot be read leaves the record as it was: the move may be
/// into the journal folder. Once the config reads, the next ask gives the record the move.
#[test]
fn a_move_while_the_config_is_unreadable_reaches_the_record_once_it_reads() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md").unwrap();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    fs::rename(e.vault.join("a.md"), e.vault.join("b.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "b.md"));
    assert_eq!(records(&e), vec![(id.clone(), "a".to_owned(), None, false)]);

    e.write(".memry/config.json", "{}");
    e.write("c.md", "Gamma\n");
    e.facts_until(added("c.md"));
    let records = records(&e);
    assert!(
        records.contains(&(id, "b".to_owned(), None, false)),
        "{records:?}"
    );
}

/// A core whose origin was not recorded (its first open stopped before, or the write failed)
/// gets it at the next open, from what is beside it then: Electron's database there means no
/// new file gets an id.
#[test]
fn an_open_records_a_missing_origin_from_what_is_beside_it() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM meta WHERE key = ?1", [VAULT_ORIGIN_META_KEY])
                .unwrap();
            Ok(())
        })
        .unwrap();
    e.close();

    fs::write(e.vault.join(".memry/data.db"), b"").unwrap();
    e.write("b.md", "Beta\n");
    reopen(&mut e);
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(origin(&e).as_deref(), Some("electron"));
    assert!(row_id(&e, "a.md").is_some());
    assert_eq!(row_id(&e, "b.md"), None);
}

/// Pinned: a note that grows into the large-file class after it was named stays a note. Its
/// record was synced, so a move still edits it, as Electron's `processRename` does, live or
/// while the app is closed (paired on the bytes, #3744). Its file is ahead of its document, so
/// a removal keeps the note (Electron deletes it): the file had text the note does not.
#[test]
fn a_named_note_that_grew_large_still_follows_its_file() {
    let mut e = notes_env();
    e.write("grow.md", "Small\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "grow.md").unwrap();
    e.write("grow.md", &"x".repeat(200 * 1024));
    until("the large text owes the file body", || {
        owes_file_body(&e, &id)
    });
    e.drain();

    fs::rename(e.vault.join("grow.md"), e.vault.join("moved.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "moved.md"));
    let live = vec![(id.clone(), "moved".to_owned(), None, false)];
    assert_eq!(records(&e), live);
    assert!(outbox(&e).contains(&("upsert".to_owned(), id.clone())));

    e.close();
    fs::rename(e.vault.join("moved.md"), e.vault.join("closed.md")).unwrap();
    reopen(&mut e);
    let live = vec![(id.clone(), "closed".to_owned(), None, false)];
    assert_eq!(records(&e), live);
    assert_eq!(row_id(&e, "closed.md"), Some(id.clone()));

    fs::remove_file(e.vault.join("closed.md")).unwrap();
    until("the removal kept the note", || {
        row_kept_without_hashes(&e, &id)
    });
    assert_eq!(records(&e), live);
    assert!(!outbox(&e).contains(&("delete".to_owned(), id)));
}

/// A file whose frontmatter does not parse is a note too (its body is the note's, #3750): moved
/// while the app is closed, it pairs on its bytes (#3744), the record follows it, and no second
/// note is made.
#[test]
fn a_file_whose_frontmatter_does_not_parse_moved_while_closed_keeps_its_note() {
    let mut e = notes_env();
    e.write("a.md", "---\nfoo: [unclosed\n---\nBody\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md").unwrap();
    e.close();

    fs::rename(e.vault.join("a.md"), e.vault.join("b.md")).unwrap();
    reopen(&mut e);
    assert_eq!(records(&e), vec![(id.clone(), "b".to_owned(), None, false)]);
    assert_eq!(row_id(&e, "b.md"), Some(id.clone()));
    assert!(!outbox(&e).contains(&("delete".to_owned(), id)));
}

/// A move the record was owed and a move after it reach the record in one edit, counted from
/// where the record was; and a move owed when the app closed reaches it at the next open, with
/// no file to ask about.
#[test]
fn an_owed_move_reaches_the_record_in_one_edit_or_at_the_next_open() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.write("x.md", "Xray\n");
    e.open();
    e.facts_until(indexed);
    let (a, x) = (row_id(&e, "a.md").unwrap(), row_id(&e, "x.md").unwrap());
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    fs::rename(e.vault.join("a.md"), e.vault.join("b.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "b.md"));
    fs::rename(e.vault.join("x.md"), e.vault.join("y.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "y.md"));
    e.write(".memry/config.json", "{}");
    let edits = clock_ticks(&e, &a);
    fs::rename(e.vault.join("b.md"), e.vault.join("c.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "c.md"));
    let now = records(&e);
    assert!(
        now.contains(&(a.clone(), "c".to_owned(), None, false)),
        "{now:?}"
    );
    assert_eq!(clock_ticks(&e, &a), edits + 1, "one edit, from a to c");
    // `x` is settled by the same ask, the first since the config read again.
    assert!(
        now.contains(&(x.clone(), "y".to_owned(), None, false)),
        "{now:?}"
    );

    // Owed again, then reopened with a config that reads: the open settles it.
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    fs::rename(e.vault.join("y.md"), e.vault.join("z.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "z.md"));
    e.close();
    e.write(".memry/config.json", "{}");
    reopen(&mut e);
    let records = records(&e);
    assert!(
        records.contains(&(x, "z".to_owned(), None, false)),
        "{records:?}"
    );
}

/// A vault config that is there but cannot be read leaves the journal folder unknown, so no
/// file is named: one under the real journal folder would get a note id instead of its day's.
#[test]
fn an_unreadable_vault_config_names_no_file() {
    let mut e = notes_env();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    e.write("Daily/2025-01-01.md", "A day\n");
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    assert!(e.rows().is_empty(), "{:?}", e.rows());
    assert!(records(&e).is_empty());
}

/// The note was created and the app stopped before its row was written: the file is offered
/// again, answered with the same note, and its body is the file's, once.
#[test]
fn a_crash_between_the_create_and_the_row_seeds_the_same_note_once() {
    let mut e = notes_env();
    e.open();
    e.facts_until(indexed);
    let store = device_key::with_device_key();
    let id = e
        .core()
        .notes_writer(store)
        .unwrap()
        .create("x".to_owned(), None)
        .unwrap();
    e.close();

    e.write("x.md", "Recovered\n");
    e.drain();
    e.open();
    let facts = e.facts_until(added("x.md"));
    assert!(
        facts
            .iter()
            .any(|f| matches!(f, Applied::Added { note_id, created: false, .. } if *note_id == id)),
        "{facts:?}"
    );
    assert_eq!(e.rows(), vec![(id.clone(), "x.md".to_owned())]);
    assert_eq!(records(&e).len(), 1);
    assert_eq!(e.body(&id), "Recovered");
}

/// The open walk makes the new files notes together (13q-7). Notes a crash left without rows
/// are among the files: each keeps its id, asked about alone, and the rest are created, once.
#[test]
fn a_walk_that_finds_notes_a_crash_left_without_rows_keeps_them_and_creates_the_rest() {
    let mut e = notes_env();
    e.open();
    e.facts_until(indexed);
    let writer = e
        .core()
        .notes_writer(device_key::with_device_key())
        .unwrap();
    let kept: Vec<String> = ["x", "y"]
        .into_iter()
        .map(|title| writer.create(title.to_owned(), None).unwrap())
        .collect();
    e.close();

    for (path, text) in [
        ("x.md", "Recovered x\n"),
        ("y.md", "Recovered y\n"),
        ("a.md", "Alpha\n"),
        ("b.md", "Beta\n"),
        ("Work/c.md", "Gamma\n"),
    ] {
        e.write(path, text);
    }
    e.drain();
    e.open();
    let facts = e.facts_until(indexed);
    for (id, path) in kept.iter().zip(["x.md", "y.md"]) {
        assert!(
            facts.iter().any(|f| matches!(f,
                Applied::Added { note_id, path: p, created: false, .. } if note_id == id && p == path)),
            "{path}: {facts:?}"
        );
    }
    for path in ["a.md", "b.md", "Work/c.md"] {
        assert!(
            facts
                .iter()
                .any(|f| matches!(f, Applied::Added { path: p, created: true, .. } if p == path)),
            "{path}: {facts:?}"
        );
        assert!(row_holds(
            &e,
            &row_id(&e, path).unwrap(),
            &fs::read_to_string(e.vault.join(path)).unwrap()
        ));
    }
    assert_eq!(e.rows().len(), 5, "{:?}", e.rows());
    assert_eq!(records(&e).len(), 5);
    assert_eq!(e.body(&kept[0]), "Recovered x");
    assert_eq!(e.body(&row_id(&e, "Work/c.md").unwrap()), "Gamma");
    let queued = outbox(&e);
    for (id, _) in e.rows() {
        let upserts = queued
            .iter()
            .filter(|(op, item)| op == "upsert" && *item == id);
        assert!(upserts.count() <= 1, "{id}: {queued:?}");
    }

    let facts = reopen(&mut e);
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Added { .. })),
        "{facts:?}"
    );
    assert_eq!(records(&e).len(), 5);
}

/// A file with writing frontmatter, CriticMarkup and link references: a value in each of the
/// body's side roots.
const RICH: &str = "---\nwriting:\n  alternatives:\n    k3x9q2:\n      versions: [soguk, buz]\n---\n\
                    Sabah <!--alt:k3x9q2-->ayaz<!--/alt:k3x9q2--> bir ruzgar.\n\n\
                    One {++added++} and {--gone--} and {~~was~>is~~}.\n\n\
                    See [the docs][ref].\n\n[ref]: https://example.com/docs\n";

/// Every root of the note's stored document, block ids aside.
fn stored_doc(e: &Env, id: &str) -> Value {
    let doc_id = format!("{LOCAL_NAMESPACE_PREFIX}{id}");
    let blobs = e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn
                .prepare("SELECT update_blob FROM yjs_updates WHERE doc_id = ?1 ORDER BY seq")
                .unwrap();
            Ok(statement
                .query_map([doc_id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<Vec<u8>>, _>>()
                .unwrap())
        })
        .unwrap();
    assert!(!blobs.is_empty(), "{id}: no body stored");
    memry_test_kit::ydoc::doc_json(&blobs)
}

/// A file the open walk makes a note together with others gets the document it gets alone:
/// every root, the side roots its writing frontmatter, CriticMarkup and link references fill
/// included.
#[test]
fn a_file_made_a_note_together_gets_the_document_it_gets_alone() {
    let mut alone = notes_env();
    alone.write("Rich.md", RICH);
    alone.open();
    alone.facts_until(indexed);

    let mut together = notes_env();
    together.write("Rich.md", RICH);
    for n in 0..4 {
        together.write(&format!("n{n}.md"), &format!("Note {n}\n"));
    }
    together.open();
    together.facts_until(indexed);

    let doc = |e: &Env| stored_doc(e, &row_id(e, "Rich.md").unwrap());
    let roots = doc(&together);
    for root in [
        "markdownSource",
        "criticMarkupMarks",
        "linkReferenceDefinitions",
        "linkReferenceUsages",
        "writingAlternatives",
    ] {
        assert!(
            roots
                .get(root)
                .is_some_and(|v| v != &serde_json::json!([]) && v != &serde_json::json!({})),
            "{root} is empty: {roots}"
        );
    }
    assert_eq!(roots, doc(&alone));
}

/// A live note no row names, in the journal folder and titled with a day, claims that day's
/// file (`claimed`, `vault/watcher.ts`): the file is the note, and no day is minted for it. The
/// core decides it in the day's transaction, reading the note's body with the converter the
/// tier built because a note may claim the file.
#[test]
fn a_note_that_claims_a_day_files_place_keeps_it() {
    let mut e = notes_env();
    e.open();
    e.facts_until(indexed);
    let store = device_key::with_device_key();
    let id = e
        .core()
        .notes_writer(store)
        .unwrap()
        .create("2025-01-01".to_owned(), Some("journal".to_owned()))
        .unwrap();
    e.close();

    e.write("journal/2025-01-01.md", "Mine\n");
    e.drain();
    e.open();
    e.facts_until(added("journal/2025-01-01.md"));
    assert_eq!(
        e.rows(),
        vec![(id.clone(), "journal/2025-01-01.md".to_owned())]
    );
    assert!(days(&e).is_empty(), "{:?}", days(&e));
    assert_eq!(e.body(&id), "Mine");
}

/// A note whose body holds an Obsidian image embed (12f-3b resolves `![[img.png]]` to an image
/// block) is still its file's note when its row is lost: the identity reads the body with the
/// vault's embeds, so the file is named by the same note, not deferred.
#[test]
fn a_note_holding_an_image_embed_is_its_files_again_when_its_row_is_lost() {
    let mut e = notes_env();
    fs::write(e.vault.join("img.png"), [0x89, b'P', b'N', b'G']).unwrap();
    e.write("x.md", "Before\n\n![[img.png]]\n\nAfter\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "x.md").unwrap();
    let lost = id.clone();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            conn.execute("DELETE FROM note_file_hashes WHERE note_id = ?1", [&lost])
                .unwrap();
            conn.execute("DELETE FROM note_files WHERE note_id = ?1", [&lost])
                .unwrap();
            Ok(())
        })
        .unwrap();

    reopen(&mut e);
    assert_eq!(row_id(&e, "x.md"), Some(id));
    assert_eq!(records(&e).len(), 1, "{:?}", records(&e));
}

#[test]
fn a_removed_file_deletes_its_note_once() {
    let mut e = notes_env();
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    e.write("a.md", "Alpha\n");
    e.facts_until(added("a.md"));
    let id = row_id(&e, "a.md").unwrap();

    fs::remove_file(e.vault.join("a.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert!(e.rows().is_empty());
    assert_eq!(records(&e), vec![(id.clone(), "a".to_owned(), None, true)]);
    let deletes: Vec<_> = outbox(&e)
        .into_iter()
        .filter(|(op, item)| op == "delete" && *item == id)
        .collect();
    assert_eq!(deletes.len(), 1, "{:?}", outbox(&e));

    // Nothing more is deleted or queued on the next open.
    reopen(&mut e);
    assert_eq!(records(&e), vec![(id.clone(), "a".to_owned(), None, true)]);
    assert_eq!(
        outbox(&e)
            .iter()
            .filter(|(op, item)| op == "delete" && *item == id)
            .count(),
        1
    );
}

// --- A vault Electron wrote ---------------------------------------------------------------

/// Copies the fixture into the env's vault, with Electron's databases unpacked where Electron
/// keeps them.
fn electron_vault(e: &Env) {
    copy_dir(Path::new(FIXTURE), &e.vault);
    for name in ["data.db", "index.db"] {
        let packed = e.vault.join(".memry").join(format!("{name}.gz"));
        let mut bytes = Vec::new();
        GzDecoder::new(fs::File::open(&packed).unwrap())
            .read_to_end(&mut bytes)
            .unwrap();
        fs::write(e.vault.join(".memry").join(name), bytes).unwrap();
        fs::remove_file(packed).unwrap();
    }
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Every file of the vault outside the app's own `.memry/core`, with its bytes.
fn files(root: &Path) -> BTreeMap<String, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, into: &mut BTreeMap<String, Vec<u8>>) {
        for entry in fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .replace('\\', "/");
            if rel == ".memry/core" {
                continue;
            }
            if path.is_dir() {
                walk(root, &path, into);
            } else {
                into.insert(rel, fs::read(&path).unwrap());
            }
        }
    }
    let mut into = BTreeMap::new();
    walk(root, root, &mut into);
    into
}

/// Electron's notes, as `electron-vault.notes.json` lists them.
fn electron_notes() -> Vec<Value> {
    let text = fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/electron-vault.notes.json"
    ))
    .unwrap();
    serde_json::from_str(&text).unwrap()
}

/// Opened before Step 36 imported its notes, an Electron vault gets no note record, row or
/// queued push: a fresh id for each file would reach the server as a second copy of every note.
/// Electron's files and databases are left as they were.
#[test]
fn an_electron_vault_not_imported_gets_no_note_and_is_left_as_it_was() {
    let mut e = notes_env();
    electron_vault(&e);
    let before = files(&e.vault);
    e.open();
    e.facts_until(indexed);
    std::thread::sleep(Duration::from_millis(300));
    reopen(&mut e);
    assert!(e.rows().is_empty(), "{:?}", e.rows());
    assert!(records(&e).is_empty(), "{:?}", records(&e));
    assert!(outbox(&e).is_empty(), "{:?}", outbox(&e));
    assert_eq!(origin(&e).as_deref(), Some("electron"));
    e.close();
    let after = files(&e.vault);
    let changed: Vec<_> = after
        .keys()
        .chain(before.keys())
        .filter(|path| before.get(*path) != after.get(*path))
        .collect();
    assert!(
        changed.is_empty(),
        "changed in the Electron vault: {changed:?}"
    );
}

/// Electron's notes were pulled into a core the app created over Electron's database, before
/// their files were named (Electron's push payloads, bodies never opened in its editor, so
/// their text is the `content` they were created with). A file whose name is its note's title
/// and whose text is the note's keeps the Electron id. A title Electron sanitized into the file
/// name (`Q3: plan?` in `Q3 plan.md`), or a second note of one title (`Plan 1.md`), matches no
/// record, and the core, which Step 36 will never import, mints no id for it: no file gets a
/// second id, and no record is pushed.
#[test]
fn an_electron_vault_whose_notes_reached_the_core_keeps_their_ids() {
    let mut e = notes_env();
    electron_vault(&e);
    e.open();
    e.facts_until(indexed);
    let notes = electron_notes();
    for (cursor, note) in notes.iter().enumerate() {
        let Some(payload) = note["payload"].as_object() else {
            continue;
        };
        let mut payload = payload.clone();
        payload.insert("clock".to_owned(), serde_json::json!({ "electron": 1 }));
        let record = InboundRecord {
            item_type: "note".to_owned(),
            item_id: note["id"].as_str().unwrap().to_owned(),
            payload_json: Value::Object(payload).to_string(),
            server_cursor: Some(cursor as i64 + 1),
            signer_device_id: Some("electron".to_owned()),
            updated_at: 1_760_000_000_000,
            deleted_at: None,
        };
        e.core()
            .db_handle()
            .call_blocking(move |conn| {
                sync_items::apply_remote(conn, &record, 1_760_000_000_000).map(drop)
            })
            .unwrap();
    }

    reopen(&mut e);
    let id = |path: &str| -> String {
        notes.iter().find(|n| n["path"] == path).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    for path in [
        "Inbox.md",
        "notes/Getting Started.md",
        "notes/Tagged.md",
        "notes/outside.md",
        "projects/2025/Plan.md",
    ] {
        assert_eq!(row_id(&e, path), Some(id(path)), "{path}");
        assert!(
            row_hash(&e, path).is_some(),
            "{path}: its move pairs by this hash"
        );
    }
    for path in [
        "notes/Q3 plan.md",
        "projects/2025/Plan 1.md",
        "journal/2025-01-01.md",
    ] {
        assert_eq!(row_id(&e, path), None, "{path}");
    }
    assert_eq!(e.body(&id("notes/Tagged.md")), "With frontmatter.");
    assert_eq!(origin(&e).as_deref(), Some("electron"));
    let records_pushed: Vec<_> = outbox(&e)
        .into_iter()
        .filter(|(op, _)| op == "upsert" || op == "delete")
        .collect();
    assert!(records_pushed.is_empty(), "{records_pushed:?}");
}

/// Reading a body for a file needs the vault's callout types; when they cannot be read the
/// file waits (the ask fails and is retried) rather than being compared with a body written
/// out without them.
#[test]
fn a_file_that_may_be_a_note_waits_while_the_callout_types_cannot_be_read() {
    let mut e = notes_env();
    e.open();
    e.facts_until(indexed);
    let record = InboundRecord {
        item_type: "note".to_owned(),
        item_id: "pulled".to_owned(),
        payload_json: serde_json::json!({
            "title": "Plan",
            "content": "Body\n",
            "fileType": "markdown",
            "folderPath": null,
            "clock": {"device-b": 1},
            "createdAt": "2025-01-01T00:00:00.000Z",
            "modifiedAt": "2025-01-01T00:00:00.000Z",
        })
        .to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-b".to_owned()),
        updated_at: 1_760_000_000_000,
        deleted_at: None,
    };
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            sync_items::apply_remote(conn, &record, 1_760_000_000_000)?;
            conn.execute_batch("DROP TABLE local_settings").unwrap();
            Ok(())
        })
        .unwrap();
    e.write("Plan.md", "Body\n");
    std::thread::sleep(vault_env::QUIET);
    assert_eq!(row_id(&e, "Plan.md"), None);
    assert_eq!(records(&e).len(), 1);
}

/// A large paste outside the app owes the file body (the document did not take it). Undone
/// outside, the file is back to the text its row names: it owes nothing more, so an edit made
/// in the app reaches the file again.
#[test]
fn a_large_paste_undone_outside_lets_the_app_write_the_file_again() {
    let (mut e, store) = notes_env_with_store();
    e.write("a.md", "Small\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md").unwrap();
    e.write("a.md", &"x".repeat(200 * 1024));
    until("the large paste owes the file body", || {
        owes_file_body(&e, &id)
    });

    e.write("a.md", "Small\n");
    until("the undone paste owes nothing", || {
        !owes_file_body(&e, &id) && row_holds(&e, &id, "Small\n")
    });
    e.drain();
    e.edit_in_app(&store, &id, "typed in the app");
    e.tier.schedule(&id);
    e.facts_until(|f| {
        matches!(f, Applied::Changed { note_id, source: ChangeSource::App, .. } if *note_id == id)
    });
    assert_eq!(e.read("a.md"), "typed in the app\n");
}

/// A note's frontmatter stops parsing outside the app (#3750), and the note is then edited in
/// the app: the write-back cannot write that file, so the edit is only in the note. Its file
/// removed, the note is kept with the edit, and no delete is pushed. The same removal of a note
/// whose file had all of it deletes the note.
#[test]
fn a_removed_file_whose_note_has_an_edit_the_file_never_got_keeps_the_note() {
    let (mut e, store) = notes_env_with_store();
    e.write("a.md", "Alpha\n");
    e.write("b.md", "Beta\n");
    e.open();
    e.facts_until(indexed);
    let (a, b) = (row_id(&e, "a.md").unwrap(), row_id(&e, "b.md").unwrap());
    std::thread::sleep(Duration::from_millis(300));
    let broken = "---\nfoo: [unclosed\n---\nBroken\n";
    e.write("a.md", broken);
    e.write("b.md", broken);
    until("both rows hold the broken files", || {
        row_holds(&e, &a, broken) && row_holds(&e, &b, broken)
    });
    // An edit stamped in the row's own millisecond is not after it.
    std::thread::sleep(Duration::from_millis(2));
    e.edit_in_app(&store, &a, "typed in the app");
    e.tier.schedule(&a);
    assert!(e.tier.flush(vault_env::WAIT));
    assert_eq!(
        e.read("a.md"),
        broken,
        "the write-back wrote over the block"
    );
    e.drain();

    fs::remove_file(e.vault.join("a.md")).unwrap();
    fs::remove_file(e.vault.join("b.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == b));
    until("the removal kept the edited note", || {
        row_kept_without_hashes(&e, &a)
    });
    let records = records(&e);
    assert!(
        records.contains(&(a.clone(), "a".to_owned(), None, false)),
        "{records:?}"
    );
    assert!(
        records.contains(&(b.clone(), "b".to_owned(), None, true)),
        "{records:?}"
    );
    let outbox = outbox(&e);
    assert!(
        !outbox.contains(&("delete".to_owned(), a.clone())),
        "{outbox:?}"
    );
    assert!(outbox.contains(&("delete".to_owned(), b)), "{outbox:?}");
    assert_eq!(e.body(&a), "typed in the app");
}

/// An owed move settles from the note's row path: the path it was owed from may hold another
/// file's slot by then, which stays that file's.
#[test]
fn a_settled_move_leaves_the_slot_of_a_file_at_the_path_it_left() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.open();
    e.facts_until(indexed);
    let a = row_id(&e, "a.md").unwrap();
    e.write(".memry/config.json", "{ \"journalFolder\": ");
    fs::rename(e.vault.join("a.md"), e.vault.join("b.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "b.md"));
    e.write("a.md", "Another file\n");
    std::thread::sleep(Duration::from_millis(1000));
    e.core()
        .db_handle()
        .call_blocking(|conn| note_positions::reorder(conn, "", &["a.md".to_owned()]))
        .unwrap();
    let kept = slot(&e, "a.md").expect("the other file's slot");

    e.write(".memry/config.json", "{}");
    e.write("c.md", "Gamma\n");
    e.facts_until(added("c.md"));
    let records = records(&e);
    assert!(
        records.contains(&(a, "b".to_owned(), None, false)),
        "{records:?}"
    );
    assert_eq!(slot(&e, "a.md"), Some(kept));
}

/// A day moved out of the journal, edited as the note it became, and moved back: the deleted
/// day has other text, so the file cannot be that day again. The note stays, owed the move,
/// instead of being deleted for a file no item would name.
#[test]
fn a_day_moved_out_edited_as_a_note_and_moved_back_keeps_the_note() {
    let mut e = notes_env();
    e.write("journal/2025-01-02.md", "A day\n");
    e.open();
    e.facts_until(added("journal/2025-01-02.md"));
    e.facts_until(indexed);
    fs::create_dir_all(e.vault.join("Notes")).unwrap();
    fs::rename(
        e.vault.join("journal/2025-01-02.md"),
        e.vault.join("Notes/2025-01-02.md"),
    )
    .unwrap();
    e.facts_until(added("Notes/2025-01-02.md"));
    let note = row_id(&e, "Notes/2025-01-02.md").unwrap();
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));
    e.write("Notes/2025-01-02.md", "As a note\n");
    until("the edit reached the note", || e.body(&note) == "As a note");

    fs::rename(
        e.vault.join("Notes/2025-01-02.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    until("the note's row follows its file", || {
        row_id(&e, "journal/2025-01-02.md").is_some()
    });
    assert_eq!(row_id(&e, "journal/2025-01-02.md"), Some(note.clone()));
    assert!(
        records(&e)
            .iter()
            .any(|(id, _, _, deleted)| id == &note && !deleted)
    );
    assert_eq!(e.body(&note), "As a note");
    assert!(!outbox(&e).contains(&("delete".to_owned(), note.clone())));
    assert_eq!(owed(&e), vec![note.clone()]);

    reopen(&mut e);
    assert_eq!(row_id(&e, "journal/2025-01-02.md"), Some(note.clone()));
    assert!(!outbox(&e).contains(&("delete".to_owned(), note)));
}

/// A day moved out of the journal and back unedited: the file is the deleted day's text, so
/// it is that day again, revived, and the note it was meanwhile is deleted, as Electron does.
#[test]
fn a_day_moved_out_and_back_unedited_is_the_day_again() {
    let mut e = notes_env();
    e.write("journal/2025-01-02.md", "A day\n");
    e.open();
    e.facts_until(added("journal/2025-01-02.md"));
    e.facts_until(indexed);
    fs::create_dir_all(e.vault.join("Notes")).unwrap();
    fs::rename(
        e.vault.join("journal/2025-01-02.md"),
        e.vault.join("Notes/2025-01-02.md"),
    )
    .unwrap();
    e.facts_until(added("Notes/2025-01-02.md"));
    let note = row_id(&e, "Notes/2025-01-02.md").unwrap();

    fs::rename(
        e.vault.join("Notes/2025-01-02.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    e.facts_until(added("journal/2025-01-02.md"));
    assert_eq!(
        row_id(&e, "journal/2025-01-02.md").as_deref(),
        Some("j2025-01-02")
    );
    assert_eq!(
        days(&e),
        vec![("j2025-01-02".to_owned(), "2025-01-02".to_owned(), false)]
    );
    assert_eq!(e.body("j2025-01-02"), "A day");
    assert!(
        records(&e)
            .iter()
            .any(|(id, _, _, deleted)| id == &note && *deleted)
    );
    assert!(outbox(&e).contains(&("delete".to_owned(), note)));
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));
}

/// A day's file deleted, then a note's file moved onto its path: the note stays, owed.
#[test]
fn a_note_moved_onto_a_deleted_days_path_keeps_the_note() {
    let mut e = notes_env();
    e.write("journal/2025-01-02.md", "A day\n");
    e.write("Meeting.md", "Agenda\n");
    e.open();
    e.facts_until(added("Meeting.md"));
    e.facts_until(indexed);
    let meeting = row_id(&e, "Meeting.md").unwrap();
    fs::remove_file(e.vault.join("journal/2025-01-02.md")).unwrap();
    until("the day is deleted", || {
        days(&e) == vec![("j2025-01-02".to_owned(), "2025-01-02".to_owned(), true)]
    });

    fs::rename(
        e.vault.join("Meeting.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    until("the note's row follows its file", || {
        row_id(&e, "journal/2025-01-02.md").is_some()
    });
    assert_eq!(row_id(&e, "journal/2025-01-02.md"), Some(meeting.clone()));
    assert!(
        records(&e)
            .iter()
            .any(|(id, _, _, deleted)| id == &meeting && !deleted)
    );
    assert_eq!(e.body(&meeting), "Agenda");
    assert!(!outbox(&e).contains(&("delete".to_owned(), meeting)));
}

/// A crash after a crossing deleted the record and before the tier dropped its row (here the
/// core's crossing with no file event, then the file moved while closed): the next open makes
/// the file anew once, and deletes nothing more.
#[test]
fn a_crossing_cut_short_after_the_records_delete_is_made_at_the_next_open() {
    let mut e = notes_env();
    e.write("2025-01-03.md", "Soon a day\n");
    e.open();
    e.facts_until(added("2025-01-03.md"));
    e.facts_until(indexed);
    let note = row_id(&e, "2025-01-03.md").unwrap();

    let id = note.clone();
    let crossed = e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            let crossing = memry_core::domain::notes::identity::Crossing {
                from_path: "2025-01-03.md",
                path: "journal/2025-01-03.md",
                title: "2025-01-03",
                folder_path: Some("journal"),
                day: Some("2025-01-03"),
                body: "Soon a day\n",
                electron_db_beside: false,
            };
            let converter = Converter::new(CalloutTypes::new(Vec::new()));
            let crossed = memry_core::domain::notes::identity::crossed(
                conn,
                Some(&converter),
                None,
                &id,
                &crossing,
                "device-a",
                1,
            );
            Ok(crossed.unwrap())
        })
        .unwrap();
    assert_eq!(
        crossed,
        memry_core::domain::notes::identity::Removed::Deleted
    );
    let deletes = |e: &Env| {
        outbox(e)
            .iter()
            .filter(|(op, id)| op == "delete" && id == &note)
            .count()
    };
    assert_eq!(deletes(&e), 1);
    assert_eq!(row_id(&e, "2025-01-03.md"), Some(note.clone()));
    e.close();
    fs::create_dir_all(e.vault.join("journal")).unwrap();
    fs::rename(
        e.vault.join("2025-01-03.md"),
        e.vault.join("journal/2025-01-03.md"),
    )
    .unwrap();

    reopen(&mut e);
    assert_eq!(
        row_id(&e, "journal/2025-01-03.md").as_deref(),
        Some("j2025-01-03")
    );
    assert_eq!(e.body("j2025-01-03"), "Soon a day");
    assert_eq!(deletes(&e), 1);
    assert!(owed(&e).is_empty(), "{:?}", owed(&e));
}

/// Writes the vault config as another program would: Electron on the same vault, a sync
/// client, a hand edit.
fn config_written_outside(e: &Env, key: &str, value: &str) {
    let path = e.vault.join(".memry/config.json");
    let mut config: Value = serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
    config[key] = Value::String(value.to_owned());
    fs::write(&path, serde_json::to_vec_pretty(&config).unwrap()).unwrap();
}

fn no_day_deleted(e: &Env) {
    assert!(
        days(e).iter().all(|(_, _, deleted)| !deleted),
        "{:?}",
        days(e)
    );
    assert!(
        !outbox(e)
            .iter()
            .any(|(op, id)| op == "delete" && id.starts_with('j')),
        "{:?}",
        outbox(e)
    );
}

/// A config another program changed (Electron on the same vault, a sync client, a hand edit)
/// makes no day a note: an edit lands in the day its row names, and the next open keeps it.
#[test]
fn an_outside_edit_of_the_journal_settings_turns_no_day_into_a_note() {
    for (key, value) in [
        ("journalFolder", "Diary"),
        ("journalDateFormat", "DD-MM-YYYY"),
    ] {
        let mut e = notes_env();
        e.write("journal/2025-01-02.md", "A day\n");
        e.open();
        e.facts_until(added("journal/2025-01-02.md"));
        e.facts_until(indexed);
        config_written_outside(&e, key, value);
        e.write("journal/2025-01-02.md", "A day, edited\n");
        until("the edit reached the day", || {
            e.body("j2025-01-02") == "A day, edited"
        });
        no_day_deleted(&e);
        reopen(&mut e);
        no_day_deleted(&e);
        assert_eq!(
            row_id(&e, "journal/2025-01-02.md").as_deref(),
            Some("j2025-01-02"),
            "{key}"
        );
    }
}

/// The journal folder renamed in Finder moves every day out of the folder the config names.
/// Crossed, each would be deleted and the delete synced (#3930); held, each stays its day, owed
/// the move until the config follows the folder, live and at the next open.
#[test]
fn a_journal_folder_renamed_outside_the_app_keeps_its_days() {
    let mut e = notes_env();
    e.write("journal/2025-01-02.md", "A day\n");
    e.write("journal/2025-01-03.md", "Another day\n");
    e.open();
    e.facts_until(added("journal/2025-01-03.md"));
    e.facts_until(indexed);
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    until("both days are at their new paths", || {
        row_id(&e, "Diary/2025-01-02.md").is_some() && row_id(&e, "Diary/2025-01-03.md").is_some()
    });
    let held = || vec!["j2025-01-02".to_owned(), "j2025-01-03".to_owned()];
    assert_eq!(
        row_id(&e, "Diary/2025-01-02.md").as_deref(),
        Some("j2025-01-02")
    );
    no_day_deleted(&e);
    assert_eq!(owed(&e), held());

    reopen(&mut e);
    no_day_deleted(&e);
    assert_eq!(owed(&e), held());
    assert_eq!(e.body("j2025-01-03"), "Another day");
}

#[test]
fn a_journal_folder_renamed_while_closed_keeps_its_days() {
    let mut e = notes_env();
    e.write("journal/2025-01-02.md", "A day\n");
    e.open();
    e.facts_until(added("journal/2025-01-02.md"));
    e.facts_until(indexed);
    e.close();
    fs::rename(e.vault.join("journal"), e.vault.join("Diary")).unwrap();
    reopen(&mut e);
    no_day_deleted(&e);
    assert_eq!(
        row_id(&e, "Diary/2025-01-02.md").as_deref(),
        Some("j2025-01-02")
    );
    assert_eq!(owed(&e), vec!["j2025-01-02".to_owned()]);
}
