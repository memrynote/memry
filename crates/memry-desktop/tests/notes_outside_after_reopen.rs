//! An outside change to a note's file in the session that created it and after the vault
//! reopened (#3912), under the running vault tier with `NotesIdentity`: a delete removes the note
//! and queues its tombstone, and an edit or a new file is reported, whether the app or another
//! program wrote the file, as Electron's watcher does in any session.

#[allow(unused_imports)]
use crate::device_key;
#[allow(unused_imports)]
use crate::vault_env;

use std::fs;
use std::sync::Arc;

use memry_core::seams::secure_store::SecureStore;
use memry_desktop::notes::create::NewNoteFile;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::service::NotesService;
use memry_desktop::vault::consumer::Applied;
use vault_env::{Env, QUIET, env, indexed};

fn opened() -> (Env, Arc<NotesService>) {
    let mut kept: Option<Arc<dyn SecureStore>> = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.open();
    e.facts_until(indexed);
    armed(&mut e);
    let notes = NotesService::new(e.tier.clone(), kept.expect("the store"));
    (e, notes)
}

/// Waits until the watcher reports: a scratch note written and deleted, each seen.
fn armed(e: &mut Env) {
    e.write("armed.md", "armed\n");
    let facts = e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == "armed.md"));
    let Some(Applied::Added { note_id, .. }) = facts.last() else {
        unreachable!("facts_until ends on the fact it waits for")
    };
    let id = note_id.clone();
    fs::remove_file(e.vault.join("armed.md")).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    e.drain();
}

fn reopened(e: &mut Env) {
    std::thread::sleep(QUIET);
    e.close();
    e.drain();
    e.open();
    e.facts_until(indexed);
    armed(e);
}

/// A note at `rel`, made in the app or written from outside.
fn made(e: &mut Env, notes: &NotesService, rel: &'static str, in_app: bool) -> String {
    if in_app {
        let (folder, title) = match rel.rsplit_once('/') {
            Some((folder, name)) => (Some(folder.to_owned()), name),
            None => (None, rel),
        };
        let note = NewNoteFile {
            title: title.trim_end_matches(".md").into(),
            content: "About it".into(),
            folder,
            ..NewNoteFile::default()
        };
        let open = e.session.current().unwrap();
        let id = notes.create(&open, note).unwrap().id;
        assert!(e.vault.join(rel).is_file());
        id
    } else {
        e.write(rel, "About it\n");
        let facts = e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == rel));
        let Some(Applied::Added { note_id, .. }) = facts.last() else {
            unreachable!("facts_until ends on the fact it waits for")
        };
        note_id.clone()
    }
}

fn deletes_queued(e: &Env, id: &str) -> usize {
    let id = id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            Ok(conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE op = 'delete' AND item_id = ?1",
                    [id],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap())
        })
        .unwrap() as usize
}

fn deleted_after_reopen(rel: &'static str, in_app: bool) {
    deleted(rel, in_app, true);
}

fn deleted(rel: &'static str, in_app: bool, reopen: bool) {
    let (mut e, notes) = opened();
    let id = made(&mut e, &notes, rel, in_app);
    if reopen {
        reopened(&mut e);
    } else {
        std::thread::sleep(QUIET);
        e.drain();
    }

    fs::remove_file(e.vault.join(rel)).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    assert!(e.rows().iter().all(|(row, _)| *row != id), "{:?}", e.rows());
    assert_eq!(deletes_queued(&e, &id), 1);
}

#[test]
fn an_outside_delete_of_an_app_written_note_at_the_root_after_a_reopen_removes_it() {
    deleted_after_reopen("Root.md", true);
}

#[test]
fn an_outside_delete_of_an_app_written_note_in_a_folder_after_a_reopen_removes_it() {
    deleted_after_reopen("Work/Plan.md", true);
}

/// The same session: the stream that saw the create is the one that must see the delete.
#[test]
fn an_outside_delete_of_an_app_written_note_in_the_same_session_removes_it() {
    deleted("Root.md", true, false);
    deleted("Work/Plan.md", true, false);
}

#[test]
fn an_outside_delete_of_an_outside_written_note_after_a_reopen_removes_it() {
    deleted_after_reopen("Work/Out.md", false);
}

/// The inverse: an outside edit of the app's file after the reopen reaches the note, and a file
/// written again at the path the delete freed is a note again.
#[test]
fn an_outside_edit_and_create_at_an_app_written_notes_path_after_a_reopen_are_reported() {
    let (mut e, notes) = opened();
    let rel = "Work/Plan.md";
    let id = made(&mut e, &notes, rel, true);
    reopened(&mut e);

    e.write(rel, "Edited outside\n");
    e.facts_until(|f| matches!(f, Applied::Changed { note_id, .. } if *note_id == id));
    assert_eq!(e.body(&id), "Edited outside");

    fs::remove_file(e.vault.join(rel)).unwrap();
    e.facts_until(|f| matches!(f, Applied::Removed { note_id, .. } if *note_id == id));
    e.write(rel, "Back again\n");
    e.facts_until(|f| matches!(f, Applied::Added { path, .. } if path == rel));
    assert!(
        e.rows().iter().any(|(_, path)| path == rel),
        "{:?}",
        e.rows()
    );
}
