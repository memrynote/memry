//! The applied-record feed of one page ([`super::feed`]): one record per item
//! with its outcome, a revived note, the attachments of an applied note, and
//! the fields a concurrent calendar merge decided.

use serde_json::{Value, json};

use super::*;
use crate::crypto::agent_envelope::AtRestKey;
use crate::storage::{open_data, test_support::temp_dir};
use crate::sync::driver::observer::{AppliedOutcome, AttachmentDownload};

const ISO: &str = "2026-09-24T08:00:00.000Z";

fn record(item_type: &str, item_id: &str, payload: Value) -> Pending {
    Pending::Record(InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: 1,
        deleted_at: None,
    })
}

fn tombstone(item_type: &str, item_id: &str, clock: Value) -> Pending {
    Pending::Tombstone {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        deleted_at: 5,
        server_cursor: Some(2),
        clock: serde_json::from_value(clock).ok(),
        body_state_vector: None,
    }
}

fn note(clock: Value) -> Value {
    json!({
        "title": "Plan", "fileType": "markdown", "folderPath": "Notes",
        "attachmentReferences": ["att-1", "att-2"],
        "clock": clock, "createdAt": ISO, "modifiedAt": ISO,
    })
}

fn source(title: &str, clock: Value) -> Value {
    json!({
        "provider": "google", "kind": "calendar", "accountId": "acc", "remoteId": "cal",
        "title": title, "timezone": "UTC", "color": "#fff", "isPrimary": false,
        "isSelected": true, "isMemryManaged": false, "syncStatus": "ok",
        "lastSyncedAt": null, "metadata": null, "archivedAt": null, "syncCursor": null,
        "clock": clock, "createdAt": ISO, "modifiedAt": ISO,
    })
}

fn page(conn: &Connection, items: Vec<Pending>) -> ApplyTotals {
    apply_page(
        conn,
        items,
        vec![],
        10,
        Some("device-a"),
        &AtRestKey::default(),
    )
    .expect("the page applies")
}

fn outcomes(totals: &ApplyTotals) -> Vec<(String, AppliedOutcome)> {
    let records = &totals.feed.records;
    records
        .iter()
        .map(|r| (r.item_id.clone(), r.outcome))
        .collect()
}

fn downloads(owner: &str) -> Vec<AttachmentDownload> {
    ["att-1", "att-2"]
        .map(|attachment_id| AttachmentDownload {
            owner_id: owner.to_owned(),
            attachment_id: attachment_id.to_owned(),
            hint: "note".to_owned(),
        })
        .to_vec()
}

#[test]
fn every_item_of_a_page_is_one_record_with_its_outcome() {
    let dir = temp_dir("feed-outcomes");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        page(
            conn,
            vec![record("note", "note00000002", note(json!({"peer": 1})))],
        );
        let totals = page(
            conn,
            vec![
                record("note", "note00000001", note(json!({"peer": 1}))),
                record("note", "note00000002", note(json!({"peer": 2}))),
                tombstone("sticky_draft", "sticky-never-seen", json!({"peer": 1})),
            ],
        );
        assert_eq!(
            outcomes(&totals),
            [
                ("note00000001".to_owned(), AppliedOutcome::Created),
                ("note00000002".to_owned(), AppliedOutcome::Updated),
                ("sticky-never-seen".to_owned(), AppliedOutcome::Deleted),
            ]
        );
        let mut wanted = downloads("note00000001");
        wanted.extend(downloads("note00000002"));
        assert_eq!(totals.feed.downloads, wanted);
        Ok(())
    })
    .expect("the pages");
}

/// Electron's `note-handler.ts:740-746`: a tombstone older than the local edit
/// is skipped and the note revived; a re-pulled identical note asks for its
/// attachments again (#2294), a note the local edit beat does not.
#[test]
fn a_losing_note_tombstone_revives_the_note_and_an_identical_skip_asks_for_files() {
    let dir = temp_dir("feed-revived");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        page(
            conn,
            vec![record("note", "note00000001", note(json!({"peer": 2})))],
        );
        let totals = page(
            conn,
            vec![
                tombstone("note", "note00000001", json!({"peer": 1})),
                record("note", "note00000001", note(json!({"peer": 2}))),
                record("note", "note00000001", note(json!({"peer": 1}))),
            ],
        );
        assert_eq!(
            outcomes(&totals),
            [
                ("note00000001".to_owned(), AppliedOutcome::Skipped),
                ("note00000001".to_owned(), AppliedOutcome::Skipped),
                ("note00000001".to_owned(), AppliedOutcome::Skipped),
            ]
        );
        assert_eq!(totals.feed.revived_notes, ["note00000001"]);
        assert_eq!(totals.feed.downloads, downloads("note00000001"));
        Ok(())
    })
    .expect("the pages");
}

/// Desktop reports a concurrent calendar apply as a conflict
/// (`calendar-source-handler.ts:73`); the feed names the field the remote won.
#[test]
fn a_concurrent_calendar_source_is_merged_with_the_field_it_decided() {
    let dir = temp_dir("feed-calendar");
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    db.call_blocking(|conn| {
        page(
            conn,
            vec![record(
                "calendar_source",
                "src-1",
                source("Work", json!({"a": 1})),
            )],
        );
        let totals = page(
            conn,
            vec![record(
                "calendar_source",
                "src-1",
                source("Office", json!({"b": 1})),
            )],
        );
        let merged = &totals.feed.records[0];
        assert_eq!(merged.outcome, AppliedOutcome::Merged);
        let fields: Vec<&str> = merged.conflicts.iter().map(|c| c.field.as_str()).collect();
        assert_eq!(fields, ["title"]);
        let title = &merged.conflicts[0];
        assert_eq!(
            (&title.losing, &title.winning, &title.merged_clock),
            (&json!("Work"), &json!("Office"), &json!({"a": 1, "b": 1}))
        );
        Ok(())
    })
    .expect("the pages");
}
