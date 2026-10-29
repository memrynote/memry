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
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::vault::consumer::Applied;
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
    e.open();
    let facts = e.facts_until(indexed);
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

/// Electron's notes reached the core as records (pulled from the server) before their files
/// were named: each file whose Electron title is its file name keeps its Electron id. A title
/// Electron sanitized into the file name (`Q3: plan?` in `Q3 plan.md`), or a second note of one
/// title (`Plan 1.md`), is not matched by its title: Step 36's import names those by path.
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
    }
    for path in ["notes/Q3 plan.md", "projects/2025/Plan 1.md"] {
        let named = row_id(&e, path).expect("a note");
        assert_ne!(named, id(path), "{path}");
    }
    assert_eq!(row_id(&e, "journal/2025-01-01.md"), None);
    assert_eq!(e.body(&id("notes/Tagged.md")), "With frontmatter.");
}
