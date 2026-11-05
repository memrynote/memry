//! An imported event a relation chip names (`resolveRefs`, `ipc/relation-handlers.ts`; #3530
//! 13q-2) against real SQLite: the mirror's title and start, the mirror as the item to focus,
//! and once promotion archived it, the native event its binding names.

use memry_core::domain::calendar_items::reads::{ExternalRelation, external_relation};
use memry_core::domain::calendar_items::write;
use memry_core::storage::repositories::sync_items::InboundRecord;
use memry_core::storage::{Db, open_data};
use memry_core::sync::apply::apply_inbound;
use serde_json::{Value, json};

const NOW: i64 = 1_790_000_000_000;

fn open() -> Db {
    let dir = tempfile::Builder::new()
        .prefix("memry-ext-relation-")
        .tempdir()
        .expect("the scratch directory")
        .keep();
    open_data(&dir.join("data.db")).expect("open data.db")
}

fn inbound(item_type: &str, id: &str, payload: &Value) -> InboundRecord {
    InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: payload.to_string(),
        server_cursor: None,
        signer_device_id: None,
        updated_at: 0,
        deleted_at: None,
    }
}

/// A Google calendar and one event mirrored from it (`calendar.json`'s promote section).
fn seeded() -> Db {
    let db = open();
    let source = json!({
        "id": "src-work", "provider": "google", "kind": "calendar", "accountId": "acct-1",
        "remoteId": "work@group.calendar.google.com", "title": "Work", "isSelected": true,
        "isPrimary": false, "isMemryManaged": false, "clock": { "desktop": 1 },
        "createdAt": "2026-09-01T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    let mirror = json!({
        "id": "ext-1", "sourceId": "src-work", "remoteEventId": "g-1", "title": "Design review",
        "startAt": "2026-09-24T07:00:00.000Z", "endAt": "2026-09-24T08:30:00.000Z",
        "isAllDay": false, "status": "confirmed", "clock": { "desktop": 2 },
        "createdAt": "2026-09-24T08:00:00.000Z", "modifiedAt": "2026-09-24T08:00:00.000Z"
    });
    db.call_blocking(move |conn| {
        apply_inbound(conn, &inbound("calendar_source", "src-work", &source), 1)?;
        apply_inbound(
            conn,
            &inbound("calendar_external_event", "ext-1", &mirror),
            1,
        )?;
        Ok(())
    })
    .unwrap();
    db
}

fn read(db: &Db, id: &'static str) -> Option<ExternalRelation> {
    db.read_blocking(move |conn| external_relation(conn, id))
        .unwrap()
}

#[test]
fn a_mirror_is_its_own_item_until_promotion_names_the_native_event() {
    let db = seeded();
    assert_eq!(
        read(&db, "ext-1"),
        Some(ExternalRelation {
            title: "Design review".into(),
            start_at: "2026-09-24T07:00:00.000Z".into(),
            calendar_item_id: "ext-1".into(),
        })
    );
    assert_eq!(read(&db, "ext-none"), None);

    let promoted = db
        .call_blocking(|conn| write::promote(conn, "ext-1", "device-a", NOW))
        .unwrap()
        .expect("a promotable mirror");
    let relation = read(&db, "ext-1").expect("an archived mirror still resolves");
    assert_eq!(relation.title, "Design review");
    assert_eq!(relation.calendar_item_id, promoted);
}
