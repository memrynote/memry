//! Reading and writing a propertied item's payload: the stored row, its
//! document clock, and the one transaction that publishes a value edit.

use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::api::errors::StorageError;
use crate::storage::repositories::instants;
use crate::storage::repositories::schema::Object;
use crate::storage::repositories::{Change, StoredPayload, sync_items};
use crate::sync::clock::{self, VectorClock};
use crate::sync::outbox;

use super::PROPERTIED_TYPES;

/// Merges the new value map into the payload and publishes the item, in one
/// transaction (FR-030, data-model §A.2).
pub(super) fn write(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
    payload: &StoredPayload,
    values: Map<String, Value>,
    device_id: &str,
    now_ms: i64,
) -> Result<Map<String, Value>, StorageError> {
    let ticked = clock::increment(
        &document_clock(payload.object(), item_type, item_id)?,
        device_id,
    );
    let modified_at = instants::to_iso8601(now_ms).ok_or_else(|| StorageError::Failed {
        what: format!("{now_ms} is not a representable instant"),
    })?;
    let changes = [
        ("properties", Change::Set(Value::Object(values.clone()))),
        ("clock", Change::set(clock_value(&ticked))),
        ("modifiedAt", Change::set(modified_at)),
    ];

    let tx = conn.unchecked_transaction().map_err(failed)?;
    sync_items::apply_local_edit_in(&tx, item_type, item_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(item_type, item_id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(values)
}

/// The stored payload of a propertied item, or `None` when there is no row.
pub(super) fn stored(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<Option<StoredPayload>, StorageError> {
    if !PROPERTIED_TYPES.contains(&item_type) {
        return Err(StorageError::Failed {
            what: format!("`{item_type}` carries no free-form property values"),
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

pub(super) fn require(
    conn: &Connection,
    item_type: &str,
    item_id: &str,
) -> Result<StoredPayload, StorageError> {
    stored(conn, item_type, item_id)?.ok_or_else(|| StorageError::Failed {
        what: format!("no {item_type}/{item_id} payload to write a property to"),
    })
}

/// The payload's `properties` object. Absent and `null` are both "no values";
/// anything else is an error rather than a substituted empty map.
pub fn read_values(
    object: &Object,
    item_type: &str,
    item_id: &str,
) -> Result<Map<String, Value>, StorageError> {
    match object.get("properties") {
        None | Some(Value::Null) => Ok(Map::new()),
        Some(Value::Object(values)) => Ok(values.clone()),
        Some(_) => Err(StorageError::Failed {
            what: format!("{item_type}/{item_id}: `properties` is not an object"),
        }),
    }
}

/// The item's document clock. A clock that will not read as ticks is a hard
/// error rather than an empty clock: an empty one lowers `clockTotal` and
/// changes who wins the next merge (chapter 06 §6.10).
pub(super) fn document_clock(
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

pub(super) fn clock_value(clock: &VectorClock) -> Value {
    Value::Object(
        clock
            .iter()
            .map(|(device, tick)| (device.clone(), Value::from(*tick)))
            .collect(),
    )
}

pub(super) fn failed(error: rusqlite::Error) -> StorageError {
    StorageError::Failed {
        what: error.to_string(),
    }
}
