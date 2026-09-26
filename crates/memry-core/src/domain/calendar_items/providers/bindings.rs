//! Binding records after a push (spec 007 CL070, desktop
//! `sync/write-engine.ts` `pushSourceToProvider` / `deleteSourceFromProvider`):
//! the synced row that says which remote event carries a Memry item.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::Target;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::BINDING_TYPE;
use crate::domain::calendar_items::write::live_payload;
use crate::domain::notes::{failed, insert_local, iso, next_clock};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

type BindingRow = (String, String, String, Option<String>, Option<String>);

/// A binding as a push needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Binding {
    pub id: String,
    pub remote_calendar_id: String,
    pub remote_event_id: String,
    pub remote_version: Option<String>,
    /// `lastLocalSnapshot` as JSON.
    pub snapshot: Option<Value>,
}

/// A CalDAV binding's `remote_event_id`: the object URL, and the occurrence's
/// recurrence id for one occurrence of a series (`href::recurrenceId`).
pub fn caldav_parts(remote_event_id: &str) -> (&str, Option<&str>) {
    match remote_event_id.split_once("::") {
        Some((href, rid)) => (href, Some(rid)),
        None => (remote_event_id, None),
    }
}

/// `storedObjectFor`: the object as last written or read, from the
/// binding's snapshot, else from any mirror row of the same object (the
/// row the event was promoted from keeps the raw text).
pub fn stored_object(conn: &Connection, binding: &Binding) -> Result<Option<String>, StorageError> {
    if let Some(raw) = binding
        .snapshot
        .as_ref()
        .and_then(|s| s.get("caldavRaw"))
        .and_then(Value::as_str)
    {
        return Ok(Some(raw.to_owned()));
    }
    let (href, _) = caldav_parts(&binding.remote_event_id);
    let mut stmt = conn
        .prepare(
            "SELECT remote_event_id, raw_payload FROM calendar_external_events
              WHERE remote_event_id = ?1 OR substr(remote_event_id, 1, length(?1) + 2) = ?1 || '::'",
        )
        .map_err(failed)?;
    let rows = stmt
        .query_map([href], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(failed)?;
    Ok(rows
        .into_iter()
        .filter(|(id, _)| caldav_parts(id).0 == href)
        .find_map(|(_, raw)| {
            let payload: Value = serde_json::from_str(&raw?).ok()?;
            payload.get("ical")?.as_str().map(str::to_owned)
        }))
}

/// `findProviderBinding`: the item's live binding on this provider.
pub fn find(
    conn: &Connection,
    provider: &str,
    target: &Target,
) -> Result<Option<Binding>, StorageError> {
    let row: Option<BindingRow> = conn
        .query_row(
            "SELECT id, remote_calendar_id, remote_event_id, remote_version, last_local_snapshot
               FROM calendar_bindings
              WHERE provider = ?1 AND source_type = ?2 AND source_id = ?3
                AND archived_at IS NULL AND deleted_at IS NULL
              ORDER BY created_at_raw, id LIMIT 1",
            params![provider, target.source_type, target.source_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .optional()
        .map_err(failed)?;
    Ok(row.map(|(id, calendar, event, version, snapshot)| Binding {
        id,
        remote_calendar_id: calendar,
        remote_event_id: event,
        remote_version: version,
        snapshot: snapshot.and_then(|s| serde_json::from_str(&s).ok()),
    }))
}

/// `findCalendarBindingByRemoteEvent`.
pub fn by_remote(
    conn: &Connection,
    provider: &str,
    calendar_id: &str,
    remote_event_id: &str,
) -> Result<Option<Target>, StorageError> {
    conn.query_row(
        "SELECT source_type, source_id FROM calendar_bindings
          WHERE provider = ?1 AND remote_calendar_id = ?2 AND remote_event_id = ?3
            AND archived_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at_raw, id LIMIT 1",
        params![provider, calendar_id, remote_event_id],
        |row| {
            Ok(Target {
                source_type: row.get(0)?,
                source_id: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// Every live binding on one CalDAV object: the whole object, or single
/// occurrences of it (`href::recurrenceId`), with the item each carries.
pub fn for_object(
    conn: &Connection,
    calendar_id: &str,
    href: &str,
) -> Result<Vec<(Target, Binding)>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT source_type, source_id, id, remote_event_id, remote_version FROM calendar_bindings
              WHERE provider = 'caldav' AND remote_calendar_id = ?1
                AND (remote_event_id = ?2 OR substr(remote_event_id, 1, length(?2) + 2) = ?2 || '::')
                AND archived_at IS NULL AND deleted_at IS NULL
              ORDER BY created_at_raw, id",
        )
        .map_err(failed)?;
    stmt.query_map(params![calendar_id, href], |row| {
        Ok((
            Target {
                source_type: row.get(0)?,
                source_id: row.get(1)?,
            },
            Binding {
                id: row.get(2)?,
                remote_calendar_id: calendar_id.to_owned(),
                remote_event_id: row.get(3)?,
                remote_version: row.get(4)?,
                snapshot: None,
            },
        ))
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

/// What the provider answered for a write.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub calendar_id: String,
    pub event_id: String,
    pub etag: Option<String>,
}

/// `pushSourceToProvider`'s bookkeeping: create or update the binding
/// (`memry_managed`, `broad`), its snapshot the input that was sent plus the
/// provider's extras (CalDAV: the object as written).
pub fn record_push(
    conn: &Connection,
    provider: &str,
    target: &Target,
    written: &Written,
    snapshot: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let existing = find(&tx, provider, target)?;
    let at = iso(now_ms)?;
    let id = existing.as_ref().map_or_else(
        || {
            format!(
                "calendar_binding:{provider}:{}:{}",
                target.source_type, target.source_id
            )
        },
        |b| b.id.clone(),
    );
    match live_payload(&tx, BINDING_TYPE, &id)? {
        Some(stored) => {
            let changes = vec![
                ("remoteCalendarId", Change::Set(json!(written.calendar_id))),
                ("remoteEventId", Change::Set(json!(written.event_id))),
                ("remoteVersion", Change::Set(json!(written.etag))),
                ("lastLocalSnapshot", Change::Set(snapshot)),
                ("archivedAt", Change::Set(Value::Null)),
                ("modifiedAt", Change::Set(json!(at))),
                ("clock", Change::Set(next_clock(&stored, device_id)?)),
            ];
            sync_items::apply_local_edit_in(&tx, BINDING_TYPE, &id, &changes, now_ms)?;
        }
        None => {
            let payload = crate::domain::notes::object(json!({
                "id": id,
                "sourceType": target.source_type,
                "sourceId": target.source_id,
                "provider": provider,
                "remoteCalendarId": written.calendar_id,
                "remoteEventId": written.event_id,
                "ownershipMode": "memry_managed",
                "writebackMode": "broad",
                "remoteVersion": written.etag,
                "lastLocalSnapshot": snapshot,
                "archivedAt": null,
                "clock": next_clock(&Map::new(), device_id)?,
                "createdAt": at,
                "modifiedAt": at,
            }));
            insert_local(&tx, BINDING_TYPE, &id, payload, now_ms)?;
        }
    }
    outbox::enqueue(&tx, &outbox::Change::upsert(BINDING_TYPE, &id), now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(id)
}

/// `deleteSourceFromProvider`'s bookkeeping: the binding is retired.
pub fn record_delete(
    conn: &Connection,
    binding_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(stored) = live_payload(&tx, BINDING_TYPE, binding_id)? {
        let at = iso(now_ms)?;
        let changes = vec![
            ("archivedAt", Change::Set(json!(at))),
            ("modifiedAt", Change::Set(json!(at))),
            ("clock", Change::Set(next_clock(&stored, device_id)?)),
        ];
        sync_items::apply_local_edit_in(&tx, BINDING_TYPE, binding_id, &changes, now_ms)?;
        outbox::enqueue(
            &tx,
            &outbox::Change::upsert(BINDING_TYPE, binding_id),
            now_ms,
        )?;
    }
    tx.commit().map_err(failed)
}

/// The snapshot a binding compares against: the input without the
/// provider's extras (desktop keeps both in one object).
pub fn same_as_snapshot(binding: &Binding, input: &Value) -> bool {
    let Some(Value::Object(snapshot)) = &binding.snapshot else {
        return false;
    };
    let Value::Object(input) = input else {
        return false;
    };
    input
        .iter()
        .all(|(key, value)| snapshot.get(key).unwrap_or(&Value::Null) == value)
}
