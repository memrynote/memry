//! Two-way calendar settings on the phone (spec 007 CL018, D3a / D7): the
//! synced `calendar.*` paths merge per key, and an older desktop whose schema
//! strips a key it does not know cannot clear it.

use std::sync::atomic::{AtomicU64, Ordering};

use memry_core::domain::settings;
use memry_core::storage::repositories::sync_items::{ApplyOutcome, InboundRecord};
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: i64 = 1_760_000_000_000;
static SCRATCH: AtomicU64 = AtomicU64::new(0);

fn open(label: &str) -> Db {
    let unique = SCRATCH.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!(
        "memry-cal-settings-{label}-{}-{unique}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("scratch");
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: "settings".to_owned(),
        item_id: "synced_settings".to_owned(),
        payload_json: payload.to_string(),
        server_cursor: Some(7),
        signer_device_id: Some("desktop".to_owned()),
        updated_at: NOW,
        deleted_at: None,
    }
}

#[test]
fn an_old_schema_upload_does_not_clear_a_key_it_strips() {
    let db = open("old");
    db.call_blocking(|conn| {
        settings::set(
            conn,
            "calendar.showNotesOnCalendar",
            json!(true),
            "phone",
            NOW,
        )?;
        let clock = settings::field_clock(conn, "calendar.showNotesOnCalendar")?.expect("clocked");
        // An older desktop merged the phone's clock, stripped the value (its
        // schema lacks the key) and re-uploads.
        let old = json!({
            "settings": {"calendar": {"weekStartDay": "sunday"}},
            "fieldClocks": {
                "calendar.showNotesOnCalendar": clock,
                "calendar.weekStartDay": {"desktop": 1}
            }
        });
        assert_eq!(
            apply_inbound(conn, &inbound(&old), NOW)?,
            ApplyOutcome::Applied
        );
        assert_eq!(
            settings::read(conn, "calendar.showNotesOnCalendar")?,
            Some(json!(true))
        );
        assert_eq!(
            settings::read(conn, "calendar.weekStartDay")?,
            Some(json!("sunday"))
        );
        Ok(())
    })
    .expect("old-schema upload");
}

#[test]
fn concurrent_edits_to_two_calendar_keys_both_survive() {
    let db = open("perkey");
    db.call_blocking(|conn| {
        settings::set(
            conn,
            "calendar.google.pushEventsToGoogle",
            json!(false),
            "phone",
            NOW,
        )?;
        let remote = json!({
            "settings": {"calendar": {"google": {"promoteConfirmDismissed": true}}},
            "fieldClocks": {"calendar.google.promoteConfirmDismissed": {"desktop": 1}}
        });
        apply_inbound(conn, &inbound(&remote), NOW)?;
        assert_eq!(
            settings::read(conn, "calendar.google.pushEventsToGoogle")?,
            Some(json!(false))
        );
        assert_eq!(
            settings::read(conn, "calendar.google.promoteConfirmDismissed")?,
            Some(json!(true))
        );
        Ok(())
    })
    .expect("per-key merge");
}

#[test]
fn a_newer_remote_value_for_the_same_key_wins() {
    let db = open("newer");
    db.call_blocking(|conn| {
        settings::set(conn, "calendar.weekStartDay", json!("monday"), "phone", NOW)?;
        let clock = settings::field_clock(conn, "calendar.weekStartDay")?.expect("clocked");
        let mut newer = serde_json::to_value(&clock).expect("clock");
        newer["desktop"] = json!(1);
        let remote = json!({
            "settings": {"calendar": {"weekStartDay": "sunday"}},
            "fieldClocks": {"calendar.weekStartDay": newer}
        });
        apply_inbound(conn, &inbound(&remote), NOW)?;
        assert_eq!(
            settings::read(conn, "calendar.weekStartDay")?,
            Some(json!("sunday"))
        );
        Ok(())
    })
    .expect("newer wins");
}
