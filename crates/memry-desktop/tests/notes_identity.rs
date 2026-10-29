//! The notes identity (Step 13d, #3530) under the vault tier: a session opens a vault, the
//! watcher reports, the consumer asks `NotesIdentity` which note each file is. The record rules
//! are `memry-core`'s `tests/domain_note_identity.rs`; these cover what only the running tier
//! shows: rows, bodies and ids across opens, and a vault Electron wrote
//! (`tests/fixtures/electron-vault`, captured by `scripts/electron-fixtures/capture-vault.mjs`).

mod device_key;
mod vault_env;

use std::collections::BTreeMap;
use std::fs;
use std::io::Read as _;
use std::path::Path;
use std::time::Duration;

use flate2::read::GzDecoder;
use memry_core::domain::notes::identity::VAULT_ORIGIN_META_KEY;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::Applied;
use rusqlite::OptionalExtension as _;
use serde_json::Value;
use vault_env::{Env, env, indexed};

const FIXTURE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/electron-vault");

fn notes_env() -> Env {
    env(|store| Some(NotesIdentity::new(store)))
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

#[test]
fn the_vaults_files_become_notes_and_a_reopen_names_none_again() {
    let mut e = notes_env();
    e.write("a.md", "Alpha\n");
    e.write("dir/b.md", "Beta\n");
    e.write("journal/2025-01-01.md", "A day\n");
    fs::write(e.vault.join("pic.png"), [0x89, b'P', b'N', b'G']).unwrap();
    // Large-file class: one block over 128 KiB. Electron never syncs it.
    e.write("big.md", &"x".repeat(200 * 1024));
    e.open();
    let facts = e.facts_until(indexed);
    assert_eq!(origin(&e).as_deref(), Some("native"));
    for path in ["a.md", "dir/b.md"] {
        assert!(
            facts
                .iter()
                .any(|f| matches!(f, Applied::Added { path: p, created: true, .. } if p == path)),
            "{path}: {facts:?}"
        );
    }
    let (a, b) = (row_id(&e, "a.md").unwrap(), row_id(&e, "dir/b.md").unwrap());
    assert_eq!(e.rows().len(), 2, "{:?}", e.rows());
    let mut want = vec![
        (a.clone(), "a".to_owned(), None, false),
        (b.clone(), "b".to_owned(), Some("dir".to_owned()), false),
    ];
    want.sort();
    assert_eq!(records(&e), want);
    assert_eq!(e.body(&a), "Alpha");
    assert_eq!(e.body(&b), "Beta");

    let facts = reopen(&mut e);
    assert!(
        !facts.iter().any(|f| matches!(f, Applied::Added { .. })),
        "{facts:?}"
    );
    assert_eq!(records(&e), want);
    assert_eq!(e.body(&a), "Alpha");
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

/// A note moved into the journal folder becomes a journal day to Electron, which deletes the
/// note and lists the day as a new item. Until Step 13m ports that, the record stays as it was
/// and nothing is pushed; the row follows the file, and the record is owed the move. Moved out
/// again, the record follows the file to where it is now.
#[test]
fn a_move_into_the_journal_folder_leaves_the_record_and_pushes_nothing() {
    let mut e = notes_env();
    e.write("2025-01-02.md", "A day to be\n");
    e.open();
    e.facts_until(added("2025-01-02.md"));
    e.facts_until(indexed);
    let id = row_id(&e, "2025-01-02.md").unwrap();
    let queued = outbox(&e);
    e.close();

    fs::create_dir_all(e.vault.join("journal")).unwrap();
    fs::rename(
        e.vault.join("2025-01-02.md"),
        e.vault.join("journal/2025-01-02.md"),
    )
    .unwrap();
    let facts = reopen(&mut e);
    assert!(
        facts.iter().any(|f| matches!(
            f,
            Applied::Renamed { note_id, new_path, .. }
                if *note_id == id && new_path == "journal/2025-01-02.md"
        )),
        "{facts:?}"
    );
    assert_eq!(
        records(&e),
        vec![(id.clone(), "2025-01-02".to_owned(), None, false)]
    );
    assert_eq!(outbox(&e), queued);
    e.close();

    fs::create_dir_all(e.vault.join("Notes")).unwrap();
    fs::rename(
        e.vault.join("journal/2025-01-02.md"),
        e.vault.join("Notes/2025-01-02.md"),
    )
    .unwrap();
    reopen(&mut e);
    assert_eq!(
        records(&e),
        vec![(id, "2025-01-02".to_owned(), Some("Notes".to_owned()), false)]
    );
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
/// record was synced, so a move still edits it, as Electron's `processRename` does. Its file is
/// ahead of its document, so the row's hash is of an older text and cannot tell a removal from
/// a move: a removal keeps the note (Electron deletes it), and a move while the app is closed
/// leaves it too, with no second note for the large file.
#[test]
fn a_named_note_that_grew_large_still_follows_its_file() {
    let mut e = notes_env();
    e.write("grow.md", "Small\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "grow.md").unwrap();
    e.write("grow.md", &"x".repeat(200 * 1024));
    std::thread::sleep(Duration::from_millis(1000));
    e.drain();

    fs::rename(e.vault.join("grow.md"), e.vault.join("moved.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Renamed { new_path, .. } if new_path == "moved.md"));
    let live = vec![(id.clone(), "moved".to_owned(), None, false)];
    assert_eq!(records(&e), live);
    assert!(outbox(&e).contains(&("upsert".to_owned(), id.clone())));

    e.close();
    fs::rename(e.vault.join("moved.md"), e.vault.join("closed.md")).unwrap();
    reopen(&mut e);
    assert_eq!(records(&e), live);
    assert_eq!(row_id(&e, "closed.md"), None);

    fs::remove_file(e.vault.join("closed.md")).unwrap();
    std::thread::sleep(vault_env::QUIET);
    assert_eq!(records(&e), live);
    assert!(!outbox(&e).contains(&("delete".to_owned(), id)));
}

/// A row with no hash of its file's text (frontmatter that does not parse, so the tier cannot
/// tell what the document holds) cannot tell a removal from a move: moved while the app is
/// closed, its note is kept and nothing is deleted. Pinned: the moved file is a second note,
/// until the tier pairs moves by the file's bytes (#3744).
#[test]
fn a_file_whose_row_holds_no_hash_moved_while_closed_keeps_its_note() {
    let mut e = notes_env();
    e.write("a.md", "---\nfoo: [unclosed\n---\nBody\n");
    e.open();
    e.facts_until(indexed);
    let id = row_id(&e, "a.md").unwrap();
    assert_eq!(row_hash(&e, "a.md"), None);
    e.close();

    fs::rename(e.vault.join("a.md"), e.vault.join("b.md")).unwrap();
    reopen(&mut e);
    let records = records(&e);
    assert!(
        records.contains(&(id.clone(), "a".to_owned(), None, false)),
        "{records:?}"
    );
    assert!(!outbox(&e).contains(&("delete".to_owned(), id.clone())));
    let second = row_id(&e, "b.md").expect("the moved file, a second note");
    assert_ne!(second, id);
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
