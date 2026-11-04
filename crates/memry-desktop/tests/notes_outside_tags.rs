//! An edit outside the app to a file's frontmatter `tags:` reaching its record (#3825), under the
//! running vault tier with `NotesIdentity` and the note index: a note's record takes the file's
//! header tags, with one outbox row per change, and a journal day's takes what the edit changed
//! in the file's list, keeping the tags only its record holds.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::index_support;
#[allow(unused_imports)]
use crate::vault_env;

use std::sync::{Arc, Mutex};

use index_support::until;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::index::NoteIndex;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::{Applied, ChangeSource};
use vault_env::{Env, QUIET, env, indexed};

fn opened() -> (Env, Arc<dyn SecureStore>) {
    let store: Mutex<Option<Arc<dyn SecureStore>>> = Mutex::default();
    let mut e = env(|s| {
        *store.lock().unwrap() = Some(s.clone());
        Some(NotesIdentity::new(s))
    });
    NoteIndex::new(e.tier.clone(), |_| {}, |_| {}, |_| {}).register(&e.session);
    e.open();
    e.facts_until(indexed);
    (e, store.into_inner().unwrap().unwrap())
}

/// The record's `tags`, as its payload holds them.
fn record_tags(e: &Env, item_type: &'static str, id: &str) -> Vec<String> {
    let id = id.to_owned();
    let payload: String = e
        .core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT payload FROM sync_items WHERE item_type = ?1 AND item_id = ?2",
                    [item_type, &id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&payload).unwrap();
    serde_json::from_value(payload["tags"].clone()).unwrap_or_default()
}

/// The record pushes queued for `id`, after the last [`clear_outbox`].
fn upserts(e: &Env, id: &str) -> i64 {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE op = 'upsert' AND item_id = ?1",
                    [id],
                    |row| row.get(0),
                )
                .unwrap())
        })
        .unwrap()
}

fn clear_outbox(e: &Env) {
    e.core()
        .db_handle()
        .call_blocking(|conn| {
            conn.execute("DELETE FROM outbox", []).unwrap();
            Ok(())
        })
        .unwrap();
}

/// Writes `text` at `rel` outside the app and waits until the consumer applied it.
fn edited_outside(e: &mut Env, id: &str, rel: &str, text: &str) {
    e.write(rel, text);
    e.facts_until(|f| {
        matches!(f, Applied::Changed { note_id, source: ChangeSource::Watcher, .. } if note_id == id)
    });
}

/// Waits until the index measured the bytes the note's row names, the base a day's edit is
/// read against.
fn measured(e: &Env, id: &str) {
    let search = e.session.current().expect("open").search;
    until("the file measured", || {
        let row = e.core().note_files().by_id(id).unwrap().expect("a row");
        let stats = search.note_stats(id).unwrap();
        row.content_hash.is_some() && stats.and_then(|s| s.file_hash) == row.content_hash
    });
}

#[test]
fn an_outside_edit_of_a_notes_tags_reaches_its_record_once_per_change() {
    let (mut e, store) = opened();
    let notes = NotesService::new(e.tier.clone(), store);
    let open = e.session.current().unwrap();
    let note = NewNoteFile {
        title: "Plan".into(),
        content: "About it".into(),
        tags: vec!["x".into()],
        ..NewNoteFile::default()
    };
    let id = notes.create(&open, note).unwrap().id;
    assert_eq!(record_tags(&e, "note", &id), ["x"]);
    std::thread::sleep(QUIET);
    e.drain();

    // `x` removed and `Y` added in another editor; `y` is the same tag and collapses into it.
    clear_outbox(&e);
    edited_outside(&mut e, &id, "Plan.md", "---\ntags: [Y, y]\n---\nAbout it\n");
    assert_eq!(record_tags(&e, "note", &id), ["Y"]);
    assert_eq!(upserts(&e, &id), 1);

    // A body edit that leaves the list as the record has it pushes no record.
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        "Plan.md",
        "---\ntags: [Y]\n---\nAbout it, again\n",
    );
    assert_eq!(record_tags(&e, "note", &id), ["Y"]);
    assert_eq!(upserts(&e, &id), 0);

    // A block that does not parse says nothing about the tags.
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        "Plan.md",
        "---\ntags: [a\n---\nAbout it, again\n",
    );
    assert_eq!(record_tags(&e, "note", &id), ["Y"]);
    assert_eq!(upserts(&e, &id), 0);

    // The whole block gone: no tags.
    clear_outbox(&e);
    edited_outside(&mut e, &id, "Plan.md", "About it, again\n");
    assert!(record_tags(&e, "note", &id).is_empty());
    assert_eq!(upserts(&e, &id), 1);
}

#[test]
fn an_outside_edit_of_a_days_tags_reaches_its_record_and_keeps_its_own() {
    let (mut e, store) = opened();
    let date = "2025-03-03";
    let (id, rel) = (format!("j{date}"), format!("journal/{date}.md"));
    e.write(
        &rel,
        "---\ndate: 2025-03-03\ntags: [walk]\n---\nBy the river.\n",
    );
    e.facts_until(|f| matches!(f, Applied::Added { note_id, .. } if *note_id == id));
    let journal = e.core().journal(store).unwrap();
    // A tag picked in the app is the record's only: a day's file never gets it.
    journal
        .set_tags(date.into(), vec!["walk".into(), "picked".into()])
        .unwrap();
    measured(&e, &id);

    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        &rel,
        "---\ndate: 2025-03-03\ntags: [run]\n---\nBy the river.\n",
    );
    assert_eq!(record_tags(&e, "journal", &id), ["picked", "run"]);
    assert_eq!(upserts(&e, &id), 1);

    // A body edit leaves the list as the last file had it: nothing to take.
    measured(&e, &id);
    clear_outbox(&e);
    edited_outside(
        &mut e,
        &id,
        &rel,
        "---\ndate: 2025-03-03\ntags: [run]\n---\nBy the sea.\n",
    );
    assert_eq!(record_tags(&e, "journal", &id), ["picked", "run"]);
    assert_eq!(upserts(&e, &id), 0);
}
