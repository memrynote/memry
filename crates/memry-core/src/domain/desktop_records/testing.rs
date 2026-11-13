//! What the `canvas_folder`, `home_page` and `sticky_draft` tests share: a real
//! `data.db`, the pushed payload and outbox of a record, and inbound records
//! through the real pull apply step.

use rusqlite::{Connection, params};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::sync_items::{self, InboundRecord};
use crate::storage::test_support::{TempDir, temp_dir};
use crate::storage::{Db, open_data};
use crate::sync::apply::{ApplyTotals, Pending, apply_page};
use crate::sync::clock::VectorClock;

pub(crate) const NOW: i64 = 1_776_297_600_000;
/// The device every local write in these tests runs as.
pub(crate) const DEVICE: &str = "device-a";

pub(crate) fn open(label: &str) -> (Db, TempDir) {
    let dir = temp_dir(label);
    let db = open_data(&dir.path().join("data.db")).expect("open data.db");
    (db, dir)
}

pub(crate) fn iso(ms: i64) -> String {
    instants::to_iso8601(ms).expect("an instant")
}

/// The payload a push of `(item_type, id)` sends.
pub(crate) fn payload(conn: &Connection, item_type: &str, id: &str) -> Value {
    let raw = sync_items::push_payload(conn, item_type, id)
        .expect("read")
        .expect("a record");
    serde_json::from_str(&raw).expect("json")
}

pub(crate) fn clock(conn: &Connection, item_type: &str, id: &str) -> VectorClock {
    serde_json::from_value(payload(conn, item_type, id)["clock"].clone()).expect("a clock")
}

/// Outbox rows of `(item_type, id)`.
pub(crate) fn queued(conn: &Connection, item_type: &str, id: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM outbox WHERE item_type = ?1 AND item_id = ?2",
        params![item_type, id],
        |row| row.get(0),
    )
    .expect("count")
}

/// Applies `items` as one pulled page, ten milliseconds after [`NOW`].
pub(crate) fn pull(conn: &Connection, items: Vec<Pending>) -> Result<ApplyTotals, StorageError> {
    apply_page(conn, items, vec![], NOW + 10, Some(DEVICE))
}

pub(crate) fn remote(item_type: &str, id: &str, body: &Value) -> Pending {
    Pending::Record(InboundRecord {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        payload_json: body.to_string(),
        server_cursor: Some(1),
        signer_device_id: Some("peer".to_owned()),
        updated_at: NOW + 5,
        deleted_at: None,
    })
}

pub(crate) fn remote_delete(item_type: &str, id: &str, clock: VectorClock) -> Pending {
    Pending::Tombstone {
        item_type: item_type.to_owned(),
        item_id: id.to_owned(),
        deleted_at: NOW + 5,
        server_cursor: Some(2),
        clock: Some(clock),
        body_state_vector: None,
    }
}
