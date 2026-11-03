//! A tag's pins (#3530 13j-2): `tags:pin-note-to-tag` and `tags:unpin-note-from-tag` write the
//! record's `pinnedTags`, and the projection keeps the instant a tag was first pinned through
//! later payloads, as Electron's `applyPinnedTags` does, so a tag's pinned notes stay in the
//! order they were pinned in.

#![cfg(feature = "markdown")]

use memry_core::api::errors::StorageError;
use memry_core::api::search::Search;
use memry_core::api::vault::Vault;
use memry_core::domain::note_files::NoteFileStat;
use memry_core::domain::note_list::NoteSort;
use memry_core::domain::tags;
use memry_core::storage::repositories::sync_items::{self, InboundRecord};
use serde_json::{Value, json};
use std::sync::Arc;

const DEVICE: &str = "device-b";

fn open() -> (tempfile::TempDir, Vault, Arc<Search>) {
    let dir = tempfile::Builder::new()
        .prefix("memry-tag-pins-")
        .tempdir()
        .expect("the scratch directory");
    let vault = Vault::open("vault-1".to_owned(), dir.path().display().to_string()).expect("open");
    let search = vault.search().expect("index.db");
    (dir, vault, search)
}

/// Applies `payload` as a pull would, at `now`, and files it.
fn pulled(vault: &Vault, item_type: &str, id: &str, payload: Value, now: i64) {
    let (kind, item, json) = (item_type.to_owned(), id.to_owned(), payload.to_string());
    vault
        .db_handle()
        .call_blocking(move |conn| {
            let record = InboundRecord {
                item_type: kind,
                item_id: item,
                payload_json: json,
                server_cursor: None,
                signer_device_id: None,
                updated_at: now,
                deleted_at: None,
            };
            sync_items::apply_remote(conn, &record, now)?;
            Ok(())
        })
        .expect("apply");
    vault
        .note_files()
        .upsert_stat(NoteFileStat {
            note_id: id.to_owned(),
            path: format!("{id}.md"),
            file_type: "markdown".to_owned(),
            mime_type: None,
            file_size: Some(1),
            content_hash: None,
            file_hash: None,
            indexed_at: 1,
        })
        .expect("row");
}

fn pin(vault: &Vault, id: &str, tag: &str, pinned: bool, now: i64) -> Result<bool, StorageError> {
    let (id, tag) = (id.to_owned(), tag.to_owned());
    vault
        .db_handle()
        .call_blocking(move |conn| tags::set_pinned(conn, &id, &tag, pinned, DEVICE, now))
}

/// The pushed payload and the outbox rows queued for `id`.
fn pushed(vault: &Vault, id: &str) -> (Value, i64) {
    let id = id.to_owned();
    vault
        .db_handle()
        .call_blocking(move |conn| {
            let raw = sync_items::push_payload(conn, "note", &id)?.expect("a payload");
            let queued: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM outbox WHERE item_id = ?1",
                    [&id],
                    |row| row.get(0),
                )
                .expect("outbox");
            Ok((serde_json::from_str(&raw).expect("JSON"), queued))
        })
        .expect("pushed")
}

/// `(id, pinned_at)` of the notes carrying `tag`, pinned first.
fn listed(search: &Search, tag: &str) -> Vec<(String, Option<i64>)> {
    search
        .tagged_notes(tag, false, NoteSort::Title, true)
        .expect("tagged")
        .notes
        .into_iter()
        .map(|note| (note.id, note.pinned_at))
        .collect()
}

fn note(title: &str, tags: &[&str], pinned: &[&str], tick: u64) -> Value {
    json!({
        "title": title, "tags": tags, "pinnedTags": pinned, "clock": {"peer": tick},
        "modifiedAt": "2026-01-02T00:00:00.000Z",
    })
}

#[test]
fn a_pin_writes_the_records_spelling_and_publishes_it_once() {
    let (_dir, vault, search) = open();
    let payload = json!({"title": "Plan", "tags": ["Work"], "clock": {"peer": 1},
                         "modifiedAt": "2026-01-02T00:00:00.000Z"});
    pulled(&vault, "note", "plan", payload, 1);

    assert!(pin(&vault, "plan", "WORK", true, 40).unwrap());
    let (payload, queued) = pushed(&vault, "plan");
    assert_eq!(payload["pinnedTags"], json!(["Work"]));
    assert_eq!(payload["clock"], json!({"peer": 1, "device-b": 1}));
    assert_eq!(
        payload["modifiedAt"], "2026-01-02T00:00:00.000Z",
        "a pin leaves the note's modified time"
    );
    assert_eq!(queued, 1);
    assert_eq!(listed(&search, "work"), [("plan".to_owned(), Some(40))]);

    assert!(
        !pin(&vault, "plan", "work", true, 50).unwrap(),
        "already pinned"
    );
    assert_eq!(pushed(&vault, "plan"), (payload, 1), "nothing written");
    assert_eq!(listed(&search, "work"), [("plan".to_owned(), Some(40))]);

    assert!(pin(&vault, "plan", "work", false, 60).unwrap());
    let (payload, queued) = pushed(&vault, "plan");
    assert_eq!(
        payload["pinnedTags"],
        json!([]),
        "an unpin travels as a list"
    );
    assert_eq!(queued, 1, "one pending upsert");
    assert_eq!(listed(&search, "work"), [("plan".to_owned(), None)]);
    assert!(
        !pin(&vault, "plan", "work", false, 70).unwrap(),
        "not pinned"
    );
    assert_eq!(pushed(&vault, "plan"), (payload, 1), "nothing written");
}

#[test]
fn a_tag_the_record_does_not_carry_and_a_missing_note_are_refused() {
    let (_dir, vault, _search) = open();
    pulled(&vault, "note", "plan", note("Plan", &["work"], &[], 1), 1);
    let before = pushed(&vault, "plan");

    let refused = pin(&vault, "plan", "body-only", true, 5).unwrap_err();
    assert!(
        matches!(refused, StorageError::Invalid { .. }),
        "{refused:?}"
    );
    let gone = pin(&vault, "nobody", "work", true, 5).unwrap_err();
    assert!(matches!(gone, StorageError::NotFound { .. }), "{gone:?}");
    assert_eq!(pushed(&vault, "plan"), before, "nothing written");
}

#[test]
fn a_journal_day_is_pinned_as_a_note_is() {
    let (_dir, vault, search) = open();
    let day = json!({"date": "2026-01-05", "tags": ["Daily"], "clock": {"peer": 1}});
    pulled(&vault, "journal", "day", day, 1);
    assert!(pin(&vault, "day", "daily", true, 9).unwrap());
    assert_eq!(listed(&search, "daily"), [("day".to_owned(), Some(9))]);
}

/// The projector restamped `pinned_at` on every apply, so any later edit of a pinned note moved
/// it to the end of the pinned list. `applyPinnedTags` stamps a newly pinned tag only.
#[test]
fn a_pinned_note_keeps_its_pin_instant_through_later_payloads() {
    let (_dir, vault, search) = open();
    pulled(&vault, "note", "a", note("A", &["work"], &["work"], 1), 3);
    pulled(&vault, "note", "b", note("B", &["work"], &["work"], 1), 5);
    let ids = |search: &Search| -> Vec<String> {
        listed(search, "work")
            .into_iter()
            .map(|(id, _)| id)
            .collect()
    };
    assert_eq!(ids(&search), ["a", "b"]);

    // `a` is edited later and stays pinned: it keeps its place before `b`.
    pulled(
        &vault,
        "note",
        "a",
        note("A edited", &["work", "x"], &["work"], 2),
        9,
    );
    assert_eq!(
        listed(&search, "work"),
        [("a".to_owned(), Some(3)), ("b".to_owned(), Some(5))]
    );

    // Unpinned, then pinned again: the new pin is the latest.
    pulled(&vault, "note", "a", note("A", &["work"], &[], 3), 10);
    pulled(&vault, "note", "a", note("A", &["work"], &["work"], 4), 12);
    assert_eq!(
        listed(&search, "work"),
        [("b".to_owned(), Some(5)), ("a".to_owned(), Some(12))]
    );
}
