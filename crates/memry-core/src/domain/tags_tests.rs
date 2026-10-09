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
fn a_case_variant_is_the_same_tag_in_any_script() {
    assert!(same_tag("Protocol", "protocol"));
    assert!(same_tag("PROTOCOL", "protocol"));
    assert!(same_tag("Café", "CAFÉ"));
    assert!(same_tag("Ünal", "ünal"));
    assert!(same_tag("İş", "iş"));
    assert!(same_tag("i\u{0307}ş", "iş"));
    assert!(!same_tag("ış", "iş"));
    assert_eq!(fold("Protocol"), "protocol");
    assert_eq!(tag_key("  İş "), "iş");
}

#[test]
fn unicode_variants_are_one_tag_in_dedupe_add_and_remove() {
    let deduped = dedupe(["Ünal", "İş", "ünal", "iş"].into_iter().map(str::to_owned));
    assert_eq!(deduped, vec!["Ünal".to_owned(), "İş".to_owned()]);

    let (db, _dir) = open(
        "tags-unicode",
        r#"{"title":"t","tags":["Ünal","İş"],"clock":{"device-a":1}}"#,
    );
    db.call_blocking(|conn| {
        assert_eq!(
            add(conn, "note", "note-1", "ünal", DEVICE, NOW + 1)?,
            vec!["Ünal", "İş"]
        );
        assert_eq!(
            remove(conn, "note", "note-1", "iş", DEVICE, NOW + 2)?,
            vec!["Ünal"]
        );
        Ok(())
    })
    .expect("unicode");
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
