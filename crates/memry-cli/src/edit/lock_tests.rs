//! `notes edit` against core body writes on another handle (#5734, #5247).
//!
//! Every handle on a vault's `data.db` authors under the device's one Yjs
//! client id. A CLI append that loads the log, lets a core write land, then
//! appends and records mints a `(client, clock)` the core write already took,
//! and a log holding one twice no longer replays. A second handle is what a
//! second process opening the vault has, so the threads here stand in for the
//! app and `memry notes edit` (or `memry journal append` and `notes edit`).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Barrier};
use std::thread;

use memry_core::api::errors::StorageError;
use memry_core::crdt::body_edit::BlockEdit;
use memry_core::crdt::registry::DocumentRegistry;
use memry_core::crdt::text_extract::extract_text;
use memry_core::crdt::update_log;
use memry_core::domain::journal_ops::body;
use memry_core::domain::{body_write, notes};
use memry_core::storage::{Db, open_data};

use super::append_locked;

const DEVICE: &str = "device-a";
const APPENDS: usize = 25;

fn scratch(label: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-cli-lock-{label}-{}-{unique}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a scratch directory");
    dir
}

fn storage(error: impl ToString) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

/// The body as a peer replays it from this vault's log. A log that no longer
/// replays fails here: that is the lost note.
fn replayed_text(path: &Path, doc_id: &str) -> String {
    let db = open_data(path).expect("reopen");
    let id = doc_id.to_string();
    let plan = db
        .call_blocking(move |conn| update_log::load_plan(conn, &id).map_err(storage))
        .expect("the log");
    let document = DocumentRegistry::new("reader", Arc::new(|_, _: &[u8]| {}))
        .get_or_open(doc_id)
        .expect("a document");
    for blob in plan.blobs() {
        document
            .apply_durable_update(blob)
            .expect("the body no longer replays");
    }
    extract_text(&document).expect("text")
}

/// Runs `core` on one handle and `notes edit` on another, at once.
fn race(path: &Path, item_type: &'static str, doc_id: &str, core: fn(&Db, usize)) {
    let start = Arc::new(Barrier::new(2));
    let app = {
        let (path, start) = (path.to_path_buf(), Arc::clone(&start));
        thread::spawn(move || {
            let db = open_data(&path).expect("the app's handle");
            start.wait();
            for append in 0..APPENDS {
                core(&db, append);
            }
        })
    };
    let cli = {
        let (path, doc_id) = (path.to_path_buf(), doc_id.to_string());
        thread::spawn(move || {
            let db = open_data(&path).expect("the CLI's handle");
            start.wait();
            for append in 0..APPENDS {
                append_locked(
                    &db,
                    item_type,
                    &doc_id,
                    &format!("cli line {append}"),
                    &format!("cli-block-{append}"),
                    DEVICE,
                    2,
                )
                .expect("notes edit");
            }
        })
    };
    app.join().expect("the app's writes");
    cli.join().expect("the CLI's writes");
}

fn assert_every_line(text: &str) {
    for append in 0..APPENDS {
        for line in [format!("app line {append}"), format!("cli line {append}")] {
            assert!(text.contains(&line), "{line:?} is missing from {text:?}");
        }
    }
}

const NOTE: &str = "note5247abcd";

fn app_note_append(db: &Db, append: usize) {
    let markdown = format!("app line {append}");
    db.call_blocking(|conn| {
        body_write::append_markdown(conn, NOTE, &markdown, DEVICE, 2).map_err(storage)
    })
    .expect("the app's append");
}

#[test]
fn notes_edit_and_a_core_note_write_on_another_handle_keep_every_line() {
    let dir = scratch("note");
    let path = dir.join("data.db");
    open_data(&path)
        .expect("open data.db")
        .call_blocking(|conn| {
            notes::create(
                conn,
                &notes::NewNote {
                    id: NOTE,
                    title: "Shared",
                    folder_path: None,
                    content: "",
                    tags: &[],
                    properties: None,
                    emoji: None,
                },
                DEVICE,
                1,
            )?;
            body_write::append_markdown(conn, NOTE, "seed", DEVICE, 1).map_err(storage)
        })
        .expect("a note with a body");

    race(&path, "note", NOTE, app_note_append);

    assert_every_line(&replayed_text(&path, NOTE));
    let _ = std::fs::remove_dir_all(&dir);
}

const DAY: &str = "2099-06-15";

/// What `memry journal append` runs.
fn app_journal_append(db: &Db, append: usize) {
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: format!("app line {append}"),
        new_block_id: format!("app-block-{append}"),
    };
    db.call_blocking(|conn| body::edit_day(conn, DAY, &edit, DEVICE, 2).map_err(storage))
        .expect("journal append");
}

#[test]
fn notes_edit_and_journal_append_on_one_day_keep_every_line() {
    let dir = scratch("journal");
    let path = dir.join("data.db");
    let day_id = open_data(&path)
        .expect("open data.db")
        .call_blocking(|conn| {
            let edit = BlockEdit::InsertParagraph {
                after_block_id: None,
                text: "seed".to_string(),
                new_block_id: "seed-block".to_string(),
            };
            body::edit_day(conn, DAY, &edit, DEVICE, 1)
                .map(|outcome| outcome.id)
                .map_err(storage)
        })
        .expect("a day with a body");

    race(&path, "journal", &day_id, app_journal_append);

    assert_every_line(&replayed_text(&path, &day_id));
    let _ = std::fs::remove_dir_all(&dir);
}
