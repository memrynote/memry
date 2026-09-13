//! Tags on a `note` or a `journal` record (T127, FR-047).
//!
//! Two rules, and they pull in opposite directions on purpose:
//!
//! - **stored exactly as typed.** The string the user typed is the string that
//!   lands in the payload's `tags` array. Nothing here lowercases, trims or
//!   canonicalises a tag against another note's spelling — that would rewrite
//!   the user's text to make a comparison cheaper.
//! - **deduped case-insensitively.** Two spellings of one tag are one tag.
//!
//! **The fold is ASCII-only, because that is what `COLLATE NOCASE` is.**
//! data-model §A.4 says `note_tags.tag` and `tag_definitions.name` are
//! `COLLATE NOCASE` and that the collation *is* what FR-047's "letter-case
//! behaviour identical to desktop" means in practice. SQLite's `NOCASE` folds
//! `A`–`Z` and nothing else, so [`same_tag`] is [`str::eq_ignore_ascii_case`]
//! and **not** `to_lowercase`. A Unicode fold here would disagree with the
//! primary key one layer down: `Café` and `CAFÉ` are two rows in `note_tags`
//! and must stay two entries in the payload, or the projection and the payload
//! stop describing the same vault.
//!
//! ## Why the edits live here and not in the projector
//!
//! `note_tags` is a cache of a parse (data-model §A.1). A tag edit therefore
//! rewrites the **payload** — by merging into the parsed copy, chapter 13 §13.2
//! rule 3 — and the projection follows from that. The merge and the outbox row
//! that publishes it commit in one transaction (FR-030, data-model §A.2).
//!
//! ## What this module does not touch
//!
//! The document's `tags` root. Chapter 12 §12.5.2 leaves the two-writer case —
//! the Y.Doc root and the record payload disagreeing — **undefined, with no
//! tiebreak**, and says a client MUST NOT construct a case that depends on
//! which wins. The record payload is where §13.7.1 puts `tags`, so that is the
//! only copy this core writes.

use rusqlite::Connection;
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

/// The two record types that carry `tags` and merge document-level
/// (chapter 13 §13.7.1, §13.7.2, chapter 06 §6.8).
///
/// `task` also carries a `tags` array and is deliberately excluded: it merges
/// field-level over `fieldClocks`, so bumping only the document clock the way
/// [`add`] does would be the wrong write. Tasks are T129's.
pub const TAGGABLE_TYPES: [&str; 2] = ["note", "journal"];

/// The case-fold key two spellings of one tag share.
///
/// ASCII-only, matching `COLLATE NOCASE`. See the module comment.
pub fn fold(tag: &str) -> String {
    tag.to_ascii_lowercase()
}

/// Whether two spellings are the same tag.
pub fn same_tag(a: &str, b: &str) -> bool {
    a.eq_ignore_ascii_case(b)
}

/// Collapses case-variant spellings, **keeping the first one seen** and the
/// order it was seen in.
///
/// First-wins rather than last-wins because the earlier entry is the one
/// already on the note: a later duplicate must not silently recase what is
/// there.
pub fn dedupe<I>(tags: I) -> Vec<String>
where
    I: IntoIterator<Item = String>,
{
    let mut kept: Vec<String> = Vec::new();
    for tag in tags {
        if !kept.iter().any(|existing| same_tag(existing, &tag)) {
            kept.push(tag);
        }
    }
    kept
}

/// The tags on an item, exactly as the payload spells them.
///
/// An item with no row reads as no tags, which is what it is. An item whose
/// payload will not parse, or whose `tags` is not an array of strings, is a
/// **hard error** and never an empty list: FR-032 states that rule for a
/// zero-row first page and it applies to every reader, because a silent empty
/// here would make the next [`set`] delete every tag on the note.
pub fn list(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    let Some(payload) = stored(conn, item_type, item_id)? else {
        return Ok(Vec::new());
    };
    read_tags(payload.object(), "tags", item_type, item_id)
}

/// Adds one tag, as typed.
///
/// A tag already on the item under any casing is not added again and **nothing
/// is written**: no payload rewrite, no clock tick, no outbox row. An edit that
/// changes nothing must not push, or every idle tap would ship a new clock and
/// win a conflict it had no business winning.
pub fn add(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let mut tags = read_tags(payload.object(), "tags", item_type, item_id)?;
    if tags.iter().any(|existing| same_tag(existing, tag)) {
        return Ok(tags);
    }
    tags.push(tag.to_owned());
    write(
        conn, item_type, item_id, &payload, tags, None, device_id, now_ms,
    )
}

/// Removes one tag, matched case-insensitively.
///
/// Also drops it from `pinnedTags` — but **only when that key is already
/// present**. Adding a `pinnedTags` key that was absent would turn §13.4's
/// "the sender does not know this field" into an explicit empty list, which is
/// how a real unpin travels, and would clear another device's pins.
pub fn remove(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tag: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let mut tags = read_tags(payload.object(), "tags", item_type, item_id)?;
    let Some(at) = tags.iter().position(|existing| same_tag(existing, tag)) else {
        return Ok(tags);
    };
    tags.remove(at);
    let pinned = unpin(payload.object(), &tags, item_type, item_id)?;
    write(
        conn, item_type, item_id, &payload, tags, pinned, device_id, now_ms,
    )
}

/// Replaces the whole list, deduped and in the given order.
pub fn set(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    tags: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let payload = require(conn, item_type, item_id)?;
    let current = read_tags(payload.object(), "tags", item_type, item_id)?;
    let next = dedupe(tags.iter().cloned());
    if next == current {
        return Ok(current);
    }
    let pinned = unpin(payload.object(), &next, item_type, item_id)?;
    write(
        conn, item_type, item_id, &payload, next, pinned, device_id, now_ms,
    )
}

/// `pinnedTags` minus every entry no longer in `tags`, or `None` when the key
/// is absent or nothing changed.
fn unpin(
    object: &Object,
    tags: &[String],
    item_type: &str,
    item_id: &str,
) -> Result<Option<Vec<String>>, StorageError> {
    if !object.contains_key("pinnedTags") {
        return Ok(None);
    }
    let pinned = read_tags(object, "pinnedTags", item_type, item_id)?;
    let kept: Vec<String> = pinned
        .iter()
        .filter(|pin| tags.iter().any(|tag| same_tag(tag, pin)))
        .cloned()
        .collect();
    Ok((kept != pinned).then_some(kept))
}

/// Merges the new arrays into the payload and publishes the item, in one
/// transaction.
///
/// `clock` is ticked because `note` and `journal` merge document-level
/// (chapter 06 §6.8): an edit that did not tick would lose to any peer's row.
/// `modifiedAt` is emitted in the **string** shape §13.5 requires.
#[allow(clippy::too_many_arguments)]
fn write(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    payload: &StoredPayload,
    tags: Vec<String>,
    pinned: Option<Vec<String>>,
    device_id: &str,
    now_ms: i64,
) -> Result<Vec<String>, StorageError> {
    let ticked = clock::increment(
        &document_clock(payload.object(), item_type, item_id)?,
        device_id,
    );
    let modified_at = instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is not a representable instant"),
    })?;

    let mut changes = vec![
        ("tags", Change::set(tags.clone())),
        ("clock", Change::set(clock_value(&ticked))),
        ("modifiedAt", Change::set(modified_at)),
    ];
    if let Some(pinned) = pinned {
        changes.push(("pinnedTags", Change::set(pinned)));
    }

    let tx = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(&tx, item_type, item_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(item_type, item_id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(tags)
}

/// The stored payload of a taggable item, or `None` when there is no row yet.
fn stored(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<StoredPayload>, StorageError> {
    if !TAGGABLE_TYPES.contains(&item_type) {
        return Err(StorageError::Failed {
            what: format!("`{item_type}` does not carry document-level tags"),
        });
    }
    let Some(row) = sync_items::load(conn, item_type, item_id)? else {
        return Ok(None);
    };
    let Some(stored) = row.payload else {
        return Ok(None);
    };
    StoredPayload::parse(&stored)
        .map(Some)
        .map_err(|error| StorageError::Failed {
            what: format!("{item_type}/{item_id} payload will not parse: {error}"),
        })
}

/// The stored payload of an item an edit is about to change. Absent is an
/// error here, unlike in [`stored`]: there is nothing to merge into.
fn require(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<StoredPayload, StorageError> {
    stored(conn, item_type, item_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no {item_type}/{item_id} payload to tag"),
    })
}

/// One of the payload's string arrays, or an error. Never a silent empty.
fn read_tags(
    object: &Object,
    key: &str,
    item_type: &str,
    item_id: &str,
) -> Result<Vec<String>, StorageError> {
    let Some(value) = object.get(key) else {
        return Ok(Vec::new());
    };
    let refuse = || StorageError::Failed {
        what: format!("{item_type}/{item_id}: `{key}` is not an array of strings"),
    };
    value
        .as_array()
        .ok_or_else(refuse)?
        .iter()
        .map(|entry| entry.as_str().map(str::to_owned).ok_or_else(refuse))
        .collect()
}

/// The item's document clock. A clock that will not read as ticks is a hard
/// error rather than an empty clock: an empty one lowers `clockTotal` and
/// changes who wins the next merge (chapter 06 §6.10).
fn document_clock(
    object: &Object,
    item_type: &str,
    item_id: &str,
) -> Result<VectorClock, StorageError> {
    let Some(value) = object.get("clock") else {
        return Ok(VectorClock::new());
    };
    let refuse = || StorageError::Failed {
        what: format!("{item_type}/{item_id}: `clock` is not a vector clock"),
    };
    value
        .as_object()
        .ok_or_else(refuse)?
        .iter()
        .map(|(device, tick)| Ok((device.clone(), tick.as_u64().ok_or_else(refuse)?)))
        .collect()
}

/// A clock as the payload spells it. `BTreeMap` gives code-point key order,
/// which is the canonical form chapter 06 §6.4.2 compares against.
fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::repositories::InboundRecord;
    use crate::storage::{Db, open_data, test_support::temp_dir};
    use serde_json::json;

    const NOW: i64 = 1_760_000_000_000;
    const DEVICE: &str = "device-b";

    /// A note a newer desktop wrote: a tag list, a pin, and one key this build
    /// has never heard of.
    const NOTE: &str = concat!(
        r#"{"title":"A note","tags":["Protocol","inbox"],"pinnedTags":["Protocol"],"#,
        r#""clock":{"device-a":2},"coverImage":{"url":"memry://cover/1"}}"#
    );

    fn open(label: &str, payload_json: &str) -> (Db, crate::storage::test_support::TempDir) {
        let dir = temp_dir(label);
        let db = open_data(&dir.path().join("data.db")).expect("open data.db");
        db.call_blocking(|conn| {
            let record = InboundRecord {
                item_type: "note".to_owned(),
                item_id: "note-1".to_owned(),
                payload_json: payload_json.to_owned(),
                server_cursor: Some(7),
                signer_device_id: Some("device-a".to_owned()),
                updated_at: NOW,
                deleted_at: None,
            };
            // Not asserted `Applied`: one test seeds a payload whose `tags` is
            // not an array, and §13.2 rule 5 stores that verbatim as corrupt
            // rather than skipping it. The bytes are what these tests read.
            sync_items::apply_remote(conn, &record, NOW)?;
            Ok(())
        })
        .expect("seed");
        (db, dir)
    }

    fn pushed(conn: &Connection) -> Value {
        let raw = sync_items::push_payload(conn, "note", "note-1")
            .expect("push payload")
            .expect("a payload");
        serde_json::from_str(&raw).expect("valid JSON")
    }

    #[test]
    fn a_case_variant_is_the_same_tag_but_a_unicode_variant_is_not() {
        assert!(same_tag("Protocol", "protocol"));
        assert!(same_tag("PROTOCOL", "protocol"));
        // `COLLATE NOCASE` folds A-Z and nothing else, so these are two tags
        // in `note_tags` and must stay two entries in the payload.
        assert!(!same_tag("Café", "CAFÉ"));
        assert_eq!(fold("Protocol"), "protocol");
    }

    #[test]
    fn dedupe_keeps_the_first_spelling_and_the_original_order() {
        let deduped = dedupe(
            ["Protocol", "inbox", "protocol", "PROTOCOL", "Inbox"]
                .into_iter()
                .map(str::to_owned),
        );
        assert_eq!(deduped, vec!["Protocol".to_owned(), "inbox".to_owned()]);
    }

    #[test]
    fn a_tag_is_stored_exactly_as_typed_and_the_unknown_key_rides_along() {
        let (db, _dir) = open("tags-add", NOTE);
        db.call_blocking(|conn| {
            let tags = add(conn, "note", "note-1", "Deep Work", DEVICE, NOW + 1)?;
            assert_eq!(tags, vec!["Protocol", "inbox", "Deep Work"]);

            let payload = pushed(conn);
            assert_eq!(payload["tags"], json!(["Protocol", "inbox", "Deep Work"]));
            assert_eq!(
                payload["coverImage"],
                json!({"url": "memry://cover/1"}),
                "§13.2 rule 3: the key this build does not model must survive"
            );
            // Document-level merge, so the edit ticks this device (§6.8).
            assert_eq!(payload["clock"], json!({"device-a": 2, "device-b": 1}));
            assert_eq!(payload["modifiedAt"], json!("2025-10-09T08:53:20.001Z"));

            let rows: Vec<String> = {
                let mut statement = conn
                    .prepare("SELECT tag FROM note_tags WHERE note_id = 'note-1' ORDER BY position")
                    .expect("prepare");
                let mapped = statement
                    .query_map([], |row| row.get::<_, String>(0))
                    .expect("query");
                mapped.map(|row| row.expect("row")).collect()
            };
            assert_eq!(rows, vec!["Protocol", "inbox", "Deep Work"]);

            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 1, "the merge and its outbox row commit together");
            Ok(())
        })
        .expect("add");
    }

    #[test]
    fn adding_a_case_variant_writes_nothing_at_all() {
        let (db, _dir) = open("tags-duplicate", NOTE);
        db.call_blocking(|conn| {
            let tags = add(conn, "note", "note-1", "PROTOCOL", DEVICE, NOW + 1)?;
            assert_eq!(tags, vec!["Protocol", "inbox"]);

            // Byte for byte what arrived: no recasing, no clock tick.
            let raw = sync_items::push_payload(conn, "note", "note-1")?.expect("a payload");
            assert_eq!(raw, NOTE);
            let queued: i64 = conn
                .query_row("SELECT COUNT(*) FROM outbox", [], |row| row.get(0))
                .expect("outbox");
            assert_eq!(queued, 0, "an edit that changes nothing must not push");
            Ok(())
        })
        .expect("duplicate");
    }

    #[test]
    fn removing_a_tag_unpins_it_and_matches_case_insensitively() {
        let (db, _dir) = open("tags-remove", NOTE);
        db.call_blocking(|conn| {
            let tags = remove(conn, "note", "note-1", "protocol", DEVICE, NOW + 1)?;
            assert_eq!(tags, vec!["inbox"]);

            let payload = pushed(conn);
            assert_eq!(payload["tags"], json!(["inbox"]));
            assert_eq!(payload["pinnedTags"], json!([]));
            Ok(())
        })
        .expect("remove");
    }

    #[test]
    fn a_note_with_no_pinned_tags_key_does_not_grow_one() {
        let (db, _dir) = open("tags-no-pins", r#"{"title":"t","tags":["a","b"]}"#);
        db.call_blocking(|conn| {
            remove(conn, "note", "note-1", "a", DEVICE, NOW + 1)?;
            let payload = pushed(conn);
            assert!(
                payload.get("pinnedTags").is_none(),
                "§13.4: absent means the sender does not know, an empty array is a clear"
            );
            Ok(())
        })
        .expect("no pins");
    }

    #[test]
    fn set_dedupes_and_keeps_the_pins_that_survive() {
        let (db, _dir) = open("tags-set", NOTE);
        db.call_blocking(|conn| {
            let next = ["inbox", "Deep Work", "INBOX"].map(str::to_owned);
            let tags = set(conn, "note", "note-1", &next, DEVICE, NOW + 1)?;
            assert_eq!(tags, vec!["inbox", "Deep Work"]);

            let payload = pushed(conn);
            assert_eq!(payload["tags"], json!(["inbox", "Deep Work"]));
            assert_eq!(payload["pinnedTags"], json!([]));
            Ok(())
        })
        .expect("set");
    }

    #[test]
    fn a_tags_array_that_will_not_read_is_an_error_and_never_an_empty_list() {
        let (db, _dir) = open("tags-unreadable", r#"{"title":"t","tags":"protocol"}"#);
        db.call_blocking(|conn| {
            assert!(
                list(conn, "note", "note-1").is_err(),
                "a silent empty here would make the next set() delete every tag"
            );
            assert!(add(conn, "note", "note-1", "x", DEVICE, NOW + 1).is_err());
            Ok(())
        })
        .expect("unreadable");
    }

    #[test]
    fn a_field_merged_type_is_refused_rather_than_document_clocked() {
        let (db, _dir) = open("tags-task", NOTE);
        db.call_blocking(|conn| {
            assert!(
                list(conn, "task", "task-1").is_err(),
                "a task merges field-level; a document clock tick is the wrong write"
            );
            Ok(())
        })
        .expect("task");
    }
}
