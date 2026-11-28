//! A note delete this device raises is recorded for the deleted-asset release (#3535, Step 18
//! S7b), as Electron's `syncNoteDelete` records it (`recordLocalItemDelete`): the delete in the
//! app, a folder delete and a file removed from the disk. A delete pulled from a peer records
//! nothing, since the device that raised it frees the assets once. The record waits out the
//! grace period ([`RELEASE_GRACE_MS`]); the caller runs the release only once caught up (S6).

#![cfg(feature = "markdown")]

#[allow(unused_imports)]
use crate::note_identity_support;

use memry_core::domain::notes::{self, folder_delete, identity};
use memry_core::storage::Db;
use memry_core::sync::attachments::plan::RELEASE_GRACE_MS;
use memry_core::sync::attachments::store::releases::{self, ItemType, RecordedIds};
use note_identity_support::{DEVICE, NOW, create, deleted, give_row, open, pulled_deleted, run};

/// Note `n1` in `Work` naming two attachments.
fn note_with_attachments(label: &str) -> Db {
    let db = open(label);
    create(&db, "n1", "Plan", Some("Work"));
    run(&db, |conn| {
        notes::add_attachment_reference(conn, "n1", "att-2", DEVICE, NOW)?;
        notes::add_attachment_reference(conn, "n1", "att-1", DEVICE, NOW)
    });
    db
}

/// Every recorded delete, due or not.
fn recorded(db: &Db) -> Vec<(ItemType, String, i64, RecordedIds)> {
    run(db, |conn| releases::due(conn, i64::MAX))
        .into_iter()
        .map(|item| {
            (
                item.item_type.unwrap(),
                item.item_id,
                item.deleted_at,
                item.attachment_ids,
            )
        })
        .collect()
}

fn assert_recorded_at(db: &Db, at: i64) {
    let ids = RecordedIds::Ids(vec!["att-1".into(), "att-2".into()]);
    assert_eq!(recorded(db), [(ItemType::Note, "n1".to_owned(), at, ids)]);
    // `release_due` at `now` reads the records due at `now - RELEASE_GRACE_MS`.
    let due_at = |now: i64| run(db, |conn| releases::due(conn, now - RELEASE_GRACE_MS)).len();
    assert_eq!(due_at(at + RELEASE_GRACE_MS - 1), 0);
    assert_eq!(due_at(at + RELEASE_GRACE_MS), 1);
}

#[test]
fn a_delete_in_the_app_records_the_notes_attachments() {
    let db = note_with_attachments("attachment-delete-app");
    run(&db, |conn| {
        notes::delete(conn, "n1", DEVICE, NOW + 1).map(drop)
    });
    assert!(deleted(&db, "n1"));
    assert_recorded_at(&db, NOW + 1);
}

#[test]
fn a_folder_delete_records_each_notes_attachments() {
    let db = note_with_attachments("attachment-delete-folder");
    run(&db, |conn| {
        folder_delete::deleted_by_app(conn, "Work", &["n1"], DEVICE, NOW + 1)
    });
    assert!(deleted(&db, "n1"));
    assert_recorded_at(&db, NOW + 1);
}

#[test]
fn a_file_removed_from_the_disk_records_its_notes_attachments() {
    let db = note_with_attachments("attachment-delete-disk");
    give_row(&db, "n1", "Work/Plan.md");
    let removed = run(&db, |conn| {
        identity::removed(conn, "n1", "Work/Plan.md", DEVICE, NOW + 1)
    });
    assert_eq!(removed, identity::Removed::Deleted);
    assert_recorded_at(&db, NOW + 1);
}

#[test]
fn a_delete_pulled_from_a_peer_records_nothing() {
    let db = note_with_attachments("attachment-delete-peer");
    pulled_deleted(&db, "note", "n1");
    assert!(deleted(&db, "n1"));
    assert!(recorded(&db).is_empty());
}

#[test]
fn a_note_with_no_attachment_records_nothing() {
    let db = open("attachment-delete-none");
    create(&db, "n1", "Plan", None);
    run(&db, |conn| {
        notes::delete(conn, "n1", DEVICE, NOW + 1).map(drop)
    });
    assert!(recorded(&db).is_empty());
}
