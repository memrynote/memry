//! Source selection (spec 007 CL013, CL036): `UPDATE_SOURCE_SELECTION` and
//! the provider's `onSelectionChanged` purge (split from [`super::write`] at
//! the 600-line ceiling).

use rusqlite::Connection;
use serde_json::{Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, iso, next_clock, tombstone_local};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

use super::write::live_payload;
use super::{BINDING_TYPE, EXTERNAL_TYPE, SOURCE_TYPE};

/// Why a selection change was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionRefusal {
    NotFound,
    NotACalendar,
}

/// `UPDATE_SOURCE_SELECTION` + `onSelectionChanged`'s purge.
pub fn set_source_selection(
    conn: &Connection,
    source_id: &str,
    selected: bool,
    device_id: &str,
    now_ms: i64,
) -> Result<Result<(), SelectionRefusal>, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(source) = live_payload(&tx, SOURCE_TYPE, source_id)? else {
        return Ok(Err(SelectionRefusal::NotFound));
    };
    let kind = source
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("calendar");
    if kind != "calendar" {
        return Ok(Err(SelectionRefusal::NotACalendar));
    }
    let provider = source
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("google")
        .to_owned();
    let remote_id = source
        .get("remoteId")
        .and_then(Value::as_str)
        .unwrap_or(source_id)
        .to_owned();
    let changes = vec![
        ("isSelected", Change::Set(json!(selected))),
        ("modifiedAt", Change::Set(json!(iso(now_ms)?))),
        ("clock", Change::Set(next_clock(&source, device_id)?)),
    ];
    sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, source_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, source_id), now_ms)?;
    if !selected {
        purge_mirrors(&tx, &provider, source_id, &remote_id, device_id, now_ms)?;
    }
    tx.commit().map_err(failed)?;
    Ok(Ok(()))
}

/// `purgeCalendarSourceMirrors`: the source's external events and the
/// bindings on its calendar go, each with a synced tombstone; an ICS
/// source's device-local mirror is simply dropped.
pub fn purge_mirrors(
    tx: &Connection,
    provider: &str,
    source_id: &str,
    remote_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let externals: Vec<String> = ids(
        tx,
        "SELECT id FROM calendar_external_events WHERE deleted_at IS NULL AND source_id = ?1",
        &[source_id],
    )?;
    let bindings: Vec<String> = ids(
        tx,
        "SELECT id FROM calendar_bindings WHERE deleted_at IS NULL AND provider = ?1
            AND remote_calendar_id = ?2",
        &[provider, remote_id],
    )?;
    for id in externals {
        tombstone_local(tx, EXTERNAL_TYPE, &id, device_id, now_ms)?;
        outbox::enqueue(tx, &outbox::Change::delete(EXTERNAL_TYPE, &id), now_ms)?;
    }
    for id in bindings {
        tombstone_local(tx, BINDING_TYPE, &id, device_id, now_ms)?;
        outbox::enqueue(tx, &outbox::Change::delete(BINDING_TYPE, &id), now_ms)?;
    }
    tx.execute(
        "DELETE FROM calendar_local_events WHERE source_id = ?1",
        [source_id],
    )
    .map_err(failed)?;
    Ok(())
}

fn ids(tx: &Connection, sql: &str, args: &[&str]) -> Result<Vec<String>, StorageError> {
    let mut stmt = tx.prepare(sql).map_err(failed)?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(args.iter()), |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}
