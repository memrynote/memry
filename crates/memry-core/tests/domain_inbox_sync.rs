//! Inbound `inbox` records (spec 006 IB011) against real SQLite, through the
//! same `apply_inbound` every pull path uses.
//!
//! | Test                                              | Desktop rule (`inbox-handler.ts`)      |
//! | ------------------------------------------------- | -------------------------------------- |
//! | a desktop full-row payload projects verbatim      | insert, defaults `Untitled` / `note`   |
//! | an older payload without the new keys keeps them  | `hasKey` absent keeps                  |
//! | an explicit null unsnoozes, unarchives and unfiles| `hasKey` present-null clears           |
//! | a null title or type keeps the local one          | `data.title ?? existing.title`         |
//! | a dominating local clock skips the remote         | `resolveClock` skip                    |
//! | a concurrent remote applies under the union clock | `resolveClock` merge (LWW)             |
//! | a tombstone hides the capture                     | `applyDelete`                          |
//! | the declaration subscribes to `inbox`             | IB012                                  |

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::inbox;
use memry_core::protocol::types::{ArrivingItemType, Declaration};
use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use rusqlite::Connection;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-inbox-sync-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn stored(conn: &Connection, item_id: &str) -> Value {
    let raw = sync_items::push_payload(conn, "inbox", item_id)
        .expect("read the row")
        .expect("a payload");
    serde_json::from_str(&raw).expect("valid JSON")
}

/// What the current desktop pushes: `JSON.stringify` of its whole
/// `inbox_items` row, local columns included.
fn desktop_row(clock: Value) -> Value {
    json!({
        "id": "inbox-1",
        "type": "link",
        "title": "How Linear builds product",
        "content": "Small teams, short cycles.",
        "createdAt": "2025-10-09T08:53:20.000Z",
        "modifiedAt": "2025-10-09T09:00:00.000Z",
        "filedAt": null,
        "filedTo": null,
        "filedAction": null,
        "snoozedUntil": "2025-10-10T09:00:00.000Z",
        "snoozeReason": "later",
        "viewedAt": null,
        "processingStatus": "complete",
        "processingError": null,
        "metadata": { "url": "https://example.com/agent/1", "fetchStatus": "complete", "siteName": "Linear" },
        "attachmentPath": null,
        "thumbnailPath": "attachments/inbox/inbox-1/thumb.jpg",
        "transcription": null,
        "transcriptionStatus": null,
        "sourceUrl": "https://example.com/agent/1",
        "sourceTitle": null,
        "captureSource": "inline",
        "archivedAt": null,
        "clock": clock,
        "syncedAt": null,
        "localOnly": false,
    })
}

fn inbound(item_id: &str, payload: &Value, deleted_at: Option<i64>) -> InboundRecord {
    InboundRecord {
        item_type: "inbox".to_owned(),
        item_id: item_id.to_owned(),
        payload_json: serde_json::to_string(payload).expect("serialise"),
        server_cursor: Some(7),
        signer_device_id: Some("device-desktop".to_owned()),
        updated_at: NOW,
        deleted_at,
    }
}

#[test]
fn the_declaration_subscribes_to_inbox() {
    let declaration = Declaration::subscribed();
    assert_eq!(declaration.classify("inbox"), ArrivingItemType::Subscribed);
    assert!(declaration.header_value().split(',').any(|t| t == "inbox"));
}

#[test]
fn a_desktop_full_row_payload_projects_verbatim() {
    let db = open("insert");
    db.call_blocking(|conn| {
        let payload = desktop_row(json!({ "desktop": 1 }));
        let record = inbound("inbox-1", &payload, None);
        assert_eq!(apply_inbound(conn, &record, NOW)?, ApplyOutcome::Applied);
        assert_eq!(
            sync_items::push_payload(conn, "inbox", "inbox-1")?,
            Some(record.payload_json.clone())
        );
        let item = inbox::get(conn, "inbox-1")?.expect("projected");
        assert_eq!(item.item_type, "link");
        assert_eq!(item.title, "How Linear builds product");
        assert_eq!(item.snooze_reason.as_deref(), Some("later"));
        assert!(item.snoozed_until.is_some());
        assert_eq!(item.capture_source.as_deref(), Some("inline"));
        assert_eq!(item.metadata_text("siteName"), Some("Linear"));
        assert_eq!(
            item.thumbnail_path.as_deref(),
            Some("attachments/inbox/inbox-1/thumb.jpg")
        );
        // Desktop's insert defaults.
        apply_inbound(
            conn,
            &inbound("bare", &json!({ "clock": { "d": 1 } }), None),
            NOW,
        )?;
        let bare = inbox::get(conn, "bare")?.expect("projected");
        assert_eq!(
            (bare.title.as_str(), bare.item_type.as_str()),
            ("Untitled", "note")
        );
        Ok(())
    })
    .expect("insert");
}

#[test]
fn an_older_payload_without_the_new_keys_keeps_them() {
    let db = open("older");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound("inbox-1", &desktop_row(json!({ "desktop": 1 })), None),
            NOW,
        )?;
        // An older build: no captureSource, no sourceTitle, no local columns.
        let older = json!({
            "title": "Renamed",
            "type": "link",
            "content": "Small teams, short cycles.",
            "clock": { "desktop": 2 },
        });
        apply_inbound(conn, &inbound("inbox-1", &older, None), NOW)?;
        let item = inbox::get(conn, "inbox-1")?.expect("live");
        assert_eq!(item.title, "Renamed");
        assert_eq!(item.capture_source.as_deref(), Some("inline"));
        assert!(item.snoozed_until.is_some(), "an absent snoozedUntil keeps");
        assert_eq!(item.metadata_text("siteName"), Some("Linear"));
        let payload = stored(conn, "inbox-1");
        assert_eq!(
            payload["thumbnailPath"],
            "attachments/inbox/inbox-1/thumb.jpg"
        );
        assert_eq!(payload["clock"], json!({ "desktop": 2 }));
        Ok(())
    })
    .expect("older payload");
}

#[test]
fn an_explicit_null_unsnoozes_unarchives_and_unfiles() {
    let db = open("clears");
    db.call_blocking(|conn| {
        let mut row = desktop_row(json!({ "desktop": 1 }));
        row["archivedAt"] = json!("2025-10-09T10:00:00.000Z");
        row["filedAt"] = json!("2025-10-09T10:00:00.000Z");
        row["filedTo"] = json!("Reading/How Linear builds product.md");
        row["filedAction"] = json!("folder");
        apply_inbound(conn, &inbound("inbox-1", &row, None), NOW)?;
        assert!(inbox::list_active(conn, true)?.is_empty());

        let clear = json!({
            "snoozedUntil": null, "snoozeReason": null, "archivedAt": null,
            "filedAt": null, "filedTo": null, "filedAction": null,
            "clock": { "desktop": 2 },
        });
        apply_inbound(conn, &inbound("inbox-1", &clear, None), NOW)?;
        let item = inbox::get(conn, "inbox-1")?.expect("live");
        assert!(item.snoozed_until.is_none() && item.snooze_reason.is_none());
        assert!(item.archived_at.is_none());
        assert!(item.filed_at.is_none() && item.filed_to.is_none() && item.filed_action.is_none());
        assert_eq!(item.title, "How Linear builds product");
        assert_eq!(inbox::list_active(conn, false)?.len(), 1);
        Ok(())
    })
    .expect("clears");
}

#[test]
fn a_null_title_or_type_keeps_the_local_one() {
    let db = open("title");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound("inbox-1", &desktop_row(json!({ "desktop": 1 })), None),
            NOW,
        )?;
        let nulls = json!({ "title": null, "type": null, "clock": { "desktop": 2 } });
        apply_inbound(conn, &inbound("inbox-1", &nulls, None), NOW)?;
        let item = inbox::get(conn, "inbox-1")?.expect("live");
        assert_eq!(item.title, "How Linear builds product");
        assert_eq!(item.item_type, "link");
        Ok(())
    })
    .expect("title");
}

#[test]
fn a_dominating_local_clock_skips_the_remote() {
    let db = open("skip");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound("inbox-1", &desktop_row(json!({ "desktop": 3 })), None),
            NOW,
        )?;
        let stale = json!({ "title": "Old", "clock": { "desktop": 1 } });
        assert_eq!(
            apply_inbound(conn, &inbound("inbox-1", &stale, None), NOW)?,
            ApplyOutcome::Skipped
        );
        assert_eq!(
            inbox::get(conn, "inbox-1")?.expect("live").title,
            "How Linear builds product"
        );
        Ok(())
    })
    .expect("skip");
}

#[test]
fn a_concurrent_remote_applies_under_the_union_clock() {
    let db = open("concurrent");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound("inbox-1", &desktop_row(json!({ "phone": 1 })), None),
            NOW,
        )?;
        let remote = json!({ "archivedAt": "2025-10-11T09:00:00.000Z", "clock": { "desktop": 1 } });
        assert_eq!(
            apply_inbound(conn, &inbound("inbox-1", &remote, None), NOW)?,
            ApplyOutcome::Applied
        );
        let payload = stored(conn, "inbox-1");
        assert_eq!(payload["clock"], json!({ "desktop": 1, "phone": 1 }));
        assert_eq!(payload["title"], "How Linear builds product");
        assert!(
            inbox::get(conn, "inbox-1")?
                .expect("live")
                .archived_at
                .is_some()
        );
        Ok(())
    })
    .expect("concurrent");
}

#[test]
fn a_tombstone_hides_the_capture() {
    let db = open("tombstone");
    db.call_blocking(|conn| {
        apply_inbound(
            conn,
            &inbound("inbox-1", &desktop_row(json!({ "desktop": 1 })), None),
            NOW,
        )?;
        let deleted = desktop_row(json!({ "desktop": 2 }));
        apply_inbound(conn, &inbound("inbox-1", &deleted, Some(NOW + 1)), NOW + 1)?;
        assert!(inbox::get(conn, "inbox-1")?.is_none());
        assert!(inbox::list_active(conn, true)?.is_empty());
        Ok(())
    })
    .expect("tombstone");
}
