//! An explicit `null` in a modelled field projects; it never lands corrupt
//! (chapter 13 §13.3, §13.4, data-model §A.4, spec-defect 53).
//!
//! This is the class of bug the vector tier cannot see. No committed payload
//! case carries an explicit `null` in a field that was not already nullable,
//! so `Field::opt` versus `Field::opt_null` is invisible until a real producer
//! writes one — and when one did, `tag_definition.icon` recorded **146 rows
//! corrupt** on a live account.
//!
//! Every case below is one type with **every** field this sweep widened set to
//! `null` at once, which is the strongest form of the claim: the reader
//! substitutes for all of them together and the writer still produces a row.
//! The payload is stored verbatim either way, so nothing the sender said is
//! lost by the substitution.

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::storage::repositories::sync_items::{self, ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;

static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-nulls-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("the scratch directory");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn record(item_type: &str, item_id: &str, payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: item_id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("device-a".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

/// Applies one payload and asserts it was **applied**, returning the row count
/// of `table` so the caller can show the projection actually happened.
fn applied(db: &Db, item_type: &str, item_id: &str, payload: Value, table: &'static str) -> i64 {
    let item_type = item_type.to_owned();
    let item_id = item_id.to_owned();
    db.call_blocking(move |conn| {
        let outcome = sync_items::apply_remote(conn, &record(&item_type, &item_id, &payload), NOW)?;
        assert_eq!(
            outcome,
            ApplyOutcome::Applied,
            "{item_type}: an explicit null must substitute, never refuse the item"
        );
        // §13.2 rule 1: the bytes are still the sender's, nulls and all.
        let stored = sync_items::push_payload(conn, &item_type, &item_id)?.expect("a payload");
        assert_eq!(stored, payload.to_string());
        let rows: i64 = conn
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .expect("count the projection");
        Ok(rows)
    })
    .expect("apply")
}

#[test]
fn a_note_with_every_widened_field_null_still_projects() {
    let db = open("note");
    let rows = applied(
        &db,
        "note",
        "abc123def456",
        json!({
            "title": null,
            "tags": null,
            "pinnedTags": null,
            "fileType": null,
            "clock": null,
            "createdAt": null,
            "modifiedAt": null,
        }),
        "notes",
    );
    assert_eq!(rows, 1);

    db.call_blocking(|conn| {
        // The two NOT NULL columns took their declared defaults (§A.4).
        let (title, file_type): (String, String) = conn
            .query_row(
                "SELECT title, file_type FROM notes WHERE id = 'abc123def456'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the note row");
        assert_eq!(title, "");
        assert_eq!(file_type, "markdown");
        Ok(())
    })
    .expect("read back");
}

#[test]
fn a_journal_with_every_widened_field_null_still_projects() {
    let db = open("journal");
    assert_eq!(
        applied(
            &db,
            "journal",
            "j2026-04-16",
            json!({
                "date": "2026-04-16",
                "title": null,
                "tags": null,
                "pinnedTags": null,
                "clock": null,
                "createdAt": null,
                "modifiedAt": null,
            }),
            "journal_entries",
        ),
        1
    );
}

/// `date` is the one field deliberately left refusing, and this pins the
/// reason: substituting would project no row, so the entry would disappear
/// with nothing recorded against it.
#[test]
fn a_journal_with_a_null_date_is_corrupt_on_purpose() {
    let db = open("journal-date");
    db.call_blocking(|conn| {
        let outcome = sync_items::apply_remote(
            conn,
            &record("journal", "j2026-04-16", &json!({"date": null})),
            NOW,
        )?;
        assert!(
            matches!(outcome, ApplyOutcome::Corrupt { .. }),
            "{outcome:?}"
        );
        Ok(())
    })
    .expect("apply");
}

#[test]
fn a_folder_config_with_every_widened_field_null_still_projects() {
    let db = open("folder");
    assert_eq!(
        applied(
            &db,
            "folder_config",
            "Notes",
            // `icon` stays `req_null` (§13.7.10): present, and `null` is one of
            // its values. The three widened here are the rest.
            json!({"icon": null, "clock": null, "createdAt": null, "modifiedAt": null}),
            "folders",
        ),
        1
    );
}

/// `custom_icon` is the one subscribed type with a reader and no table, so the
/// claim is only about the reader: a null field is read, not refused.
#[test]
fn a_custom_icon_with_every_widened_field_null_is_read_rather_than_refused() {
    let db = open("icon");
    db.call_blocking(|conn| {
        let payload = json!({
            "name": null,
            "ext": null,
            "data": null,
            "clock": null,
            "createdAt": null,
            "updatedAt": null,
        });
        let outcome =
            sync_items::apply_remote(conn, &record("custom_icon", "icon-1", &payload), NOW)?;
        assert_eq!(outcome, ApplyOutcome::Applied);
        Ok(())
    })
    .expect("apply");
}

#[test]
fn a_tag_definition_with_every_widened_field_null_still_projects() {
    let db = open("tag");
    let rows = applied(
        &db,
        "tag_definition",
        "protocol",
        json!({
            // `name` and `color` are required by §13.7.7 and stay that way.
            "name": "protocol",
            "color": "#4f46e5",
            // The field spec-defect 53 was actually about, plus its neighbours.
            "icon": null,
            "categoryId": null,
            "views": null,
            "sortOrder": null,
            "colorAuthored": null,
            "clock": null,
            "createdAt": null,
        }),
        "tag_definitions",
    );
    assert_eq!(rows, 1);

    db.call_blocking(|conn| {
        let (sort_order, color_authored): (i64, i64) = conn
            .query_row(
                "SELECT sort_order, color_authored FROM tag_definitions WHERE name = 'protocol'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the tag row");
        assert_eq!(sort_order, 0, "the column default");
        // §13.7.7: a `colorAuthored` this reader cannot resolve is "cannot
        // tell", and the receiver honours the colour.
        assert_eq!(color_authored, 1);
        Ok(())
    })
    .expect("read back");
}

#[test]
fn a_tag_category_with_every_widened_field_null_still_projects() {
    let db = open("category");
    assert_eq!(
        applied(
            &db,
            "tag_category",
            "cat-1",
            json!({
                "name": "Topics",
                "sortOrder": 1,
                "clock": null,
                "createdAt": null,
                "updatedAt": null,
                "deletedAt": null,
            }),
            "tag_categories",
        ),
        1
    );
}

#[test]
fn a_property_definition_with_every_widened_field_null_still_projects() {
    let db = open("property");
    assert_eq!(
        applied(
            &db,
            "property_definition",
            "area",
            json!({
                "name": "area",
                "type": "select",
                "options": null,
                "defaultValue": null,
                "color": null,
                "clock": null,
                "createdAt": null,
            }),
            "property_definitions",
        ),
        1
    );
}

#[test]
fn a_template_with_every_widened_field_null_still_projects() {
    let db = open("template");
    let rows = applied(
        &db,
        "template",
        "tpl-1",
        json!({
            "name": null,
            "description": null,
            "icon": null,
            "tags": null,
            "properties": null,
            "content": null,
            "clock": null,
            "createdAt": null,
            "modifiedAt": null,
        }),
        "templates",
    );
    assert_eq!(rows, 1);

    db.call_blocking(|conn| {
        let (name, content): (String, String) = conn
            .query_row(
                "SELECT name, content FROM templates WHERE id = 'tpl-1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("the template row");
        assert_eq!(name, "");
        assert_eq!(content, "");
        Ok(())
    })
    .expect("read back");
}

#[test]
fn a_reminder_with_every_widened_field_null_still_projects() {
    let db = open("reminder");
    let rows = applied(
        &db,
        "reminder",
        "rem-1",
        json!({
            "targetType": null,
            "targetId": null,
            "remindAt": null,
            "status": null,
            "anchorId": null,
            "highlightText": null,
            "highlightStart": null,
            "highlightEnd": null,
            "title": null,
            "note": null,
            "dismissedAt": null,
            "snoozedUntil": null,
            "clock": null,
            "createdAt": null,
            "modifiedAt": null,
        }),
        "reminders",
    );
    assert_eq!(rows, 1);

    db.call_blocking(|conn| {
        let status: String = conn
            .query_row(
                "SELECT status FROM reminders WHERE id = 'rem-1'",
                [],
                |row| row.get(0),
            )
            .expect("the reminder row");
        assert_eq!(status, "pending", "the column default");
        Ok(())
    })
    .expect("read back");
}

#[test]
fn a_task_activity_with_every_widened_field_null_still_projects() {
    let db = open("activity");
    assert_eq!(
        applied(
            &db,
            "task_activity",
            "act-1",
            json!({
                "taskId": null,
                "action": null,
                "field": null,
                "oldValue": null,
                "newValue": null,
                "actor": null,
                "deviceId": null,
                "clock": null,
                // §13.12's retention reads this: a row whose `createdAt` this
                // reader cannot resolve is not beyond the horizon, so it
                // applies rather than expiring.
                "createdAt": null,
            }),
            "task_activity",
        ),
        1
    );
}
