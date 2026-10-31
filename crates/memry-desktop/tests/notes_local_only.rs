//! Local-only notes (Step 13n, #3530) over a vault the running tier adopted: the flag reads back
//! on the note and the list, nothing of the note is queued while it is set, whether the edit
//! comes from the editor or from the file, and clearing it queues the whole note.

mod device_key;
mod vault_env;

use std::sync::Arc;

use memry_core::crdt::body_edit::BlockEdit;
use memry_core::seams::secure_store::SecureStore;
use memry_desktop::error::CoreError;
use memry_desktop::notes::error::NotesError;
use memry_desktop::notes::identity::NotesIdentity;
use memry_desktop::notes::local_only::{self, LocalOnlyError};
use memry_desktop::notes::read;
use memry_desktop::notes::view::NoteListOptions;
use memry_desktop::session::OpenVault;
use memry_desktop::vault::consumer::Applied;
use vault_env::{Env, env, indexed};

/// A vault of two notes, opened and walked; the identity makes both.
fn opened() -> (Env, OpenVault, Arc<dyn SecureStore>) {
    let mut kept = None;
    let mut e = env(|store| {
        kept = Some(store.clone());
        Some(NotesIdentity::new(store))
    });
    e.write("Plan.md", "First line\n");
    e.write("Other.md", "Other text\n");
    e.open();
    e.facts_until(indexed);
    let open = e.session.current().expect("open");
    (e, open, kept.expect("the store"))
}

fn id_of(open: &OpenVault, path: &str) -> String {
    read::get_by_path(open, path, None).unwrap().expect(path).id
}

/// The ops queued for `note_id`, oldest first.
fn queued(e: &Env, note_id: &str) -> Vec<String> {
    let id = note_id.to_owned();
    e.core()
        .db_handle()
        .call_blocking(move |conn| {
            let mut statement = conn
                .prepare("SELECT op FROM outbox WHERE item_id = ?1 ORDER BY id")
                .unwrap();
            Ok(statement
                .query_map([id], |row| row.get(0))
                .unwrap()
                .collect::<Result<Vec<String>, _>>()
                .unwrap())
        })
        .unwrap()
}

fn listed_local_only(open: &OpenVault, note_id: &str) -> bool {
    let page = read::list(open, &NoteListOptions::default()).unwrap();
    page.notes
        .into_iter()
        .find(|note| note.id == note_id)
        .expect("listed")
        .local_only
}

#[test]
fn a_local_only_note_queues_nothing_from_the_editor_or_its_file_until_it_syncs_again() {
    let (mut e, open, store) = opened();
    let plan = id_of(&open, "Plan.md");
    let other = id_of(&open, "Other.md");
    // The adopted note was queued for its first push.
    assert!(!queued(&e, &plan).is_empty());
    assert!(!read::get(&open, &plan, None).unwrap().unwrap().local_only);

    let note = local_only::set(&open, &plan, true, None).unwrap();
    assert!(note.local_only);
    assert_eq!(note.content, "First line\n");
    assert!(read::get(&open, &plan, None).unwrap().unwrap().local_only);
    assert!(listed_local_only(&open, &plan));
    assert!(!listed_local_only(&open, &other));
    assert_eq!(local_only::count(&open).unwrap(), 1);
    // What was queued before the toggle is dropped; the other note keeps its rows.
    assert_eq!(queued(&e, &plan), Vec::<String>::new());
    assert!(!queued(&e, &other).is_empty());

    e.edit_in_app(&store, &plan, "Typed while local only");
    e.write("Plan.md", "Edited outside while local only\n");
    e.facts_until(|fact| matches!(fact, Applied::Changed { note_id, .. } if *note_id == plan));
    assert_eq!(e.body(&plan), "Edited outside while local only");
    assert_eq!(queued(&e, &plan), Vec::<String>::new());

    let note = local_only::set(&open, &plan, false, None).unwrap();
    assert!(!note.local_only);
    assert_eq!(local_only::count(&open).unwrap(), 0);
    // The record and the whole body, once.
    assert_eq!(queued(&e, &plan), ["upsert", "crdt-update"]);
    local_only::set(&open, &plan, false, None).unwrap();
    assert_eq!(queued(&e, &plan), ["upsert", "crdt-update"]);
}

#[test]
fn a_note_that_is_not_live_is_not_found_and_keeps_its_flag() {
    let (e, open, _) = opened();
    let missing = local_only::set(&open, "no-such-note", true, None).unwrap_err();
    assert!(matches!(
        missing,
        LocalOnlyError::Notes(NotesError::NotFound(_))
    ));
    assert_eq!(missing.kind_and_code().1, "note_not_found");

    // A tombstone whose file row is still there, as a delete from another device leaves it
    // until the write-back removes the file.
    let plan = id_of(&open, "Plan.md");
    let conn = rusqlite::Connection::open(e.vault.join(".memry/core/data.db")).unwrap();
    conn.execute(
        "UPDATE notes SET deleted_at = 1 WHERE id = ?1",
        [plan.as_str()],
    )
    .unwrap();
    let deleted = local_only::set(&open, &plan, true, None).unwrap_err();
    assert!(matches!(
        deleted,
        LocalOnlyError::Notes(NotesError::NotFound(_))
    ));
    assert!(
        !e.core()
            .note_files()
            .by_id(&plan)
            .unwrap()
            .unwrap()
            .local_only
    );
    assert_eq!(local_only::count(&open).unwrap(), 0);
}

#[test]
fn a_deleted_local_only_note_is_no_longer_counted() {
    let (e, open, _) = opened();
    let plan = id_of(&open, "Plan.md");
    local_only::set(&open, &plan, true, None).unwrap();
    assert_eq!(local_only::count(&open).unwrap(), 1);

    // Tombstoned, with its file row still there, as a delete from another device leaves it.
    let conn = rusqlite::Connection::open(e.vault.join(".memry/core/data.db")).unwrap();
    conn.execute(
        "UPDATE notes SET deleted_at = 1 WHERE id = ?1",
        [plan.as_str()],
    )
    .unwrap();
    assert!(
        e.core()
            .note_files()
            .by_id(&plan)
            .unwrap()
            .unwrap()
            .local_only
    );
    assert_eq!(local_only::count(&open).unwrap(), 0);
}

/// `len` characters of xorshift noise, which no compressor shrinks much.
fn incompressible(len: usize) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut state: u64 = 0x2545_f491_4f6c_dd1d;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            char::from(ALPHABET[(state % 64) as usize])
        })
        .collect()
}

#[test]
fn a_note_too_large_to_sync_stays_local_only_and_says_so() {
    let (e, open, store) = opened();
    let plan = id_of(&open, "Plan.md");
    local_only::set(&open, &plan, true, None).unwrap();
    // About 8 MiB of noise seals to more than the 5 MiB the server takes as one update
    // (chapter 07 §7.3).
    let writer = e.core().notes_writer(store).unwrap();
    let edit = BlockEdit::InsertParagraph {
        after_block_id: None,
        text: incompressible(8 * 1024 * 1024),
        new_block_id: "noise".to_owned(),
    };
    assert!(writer.edit_block(plan.clone(), edit).unwrap());

    let refused = local_only::set(&open, &plan, false, None).unwrap_err();
    assert!(matches!(refused, LocalOnlyError::TooLargeToSync));
    assert_eq!(refused.kind_and_code().1, "note_too_large_to_sync");
    assert!(
        e.core()
            .note_files()
            .by_id(&plan)
            .unwrap()
            .unwrap()
            .local_only
    );
    assert_eq!(queued(&e, &plan), Vec::<String>::new());
    assert_eq!(local_only::count(&open).unwrap(), 1);
}
