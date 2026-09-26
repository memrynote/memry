//! Single-row and list reads: `LIST_SOURCES` (sorted accounts first, then by
//! title), `GET_EVENT`, `getExternalEventDetails`, and the projects linking an
//! event.

use rusqlite::{Connection, OptionalExtension};
use serde_json::Value;

use crate::api::calendar_records::{
    CalendarEventRecord, CalendarExternalEventRecord, CalendarItemBinding, CalendarLinkedProject,
    CalendarSourceRecord,
};
use crate::api::errors::StorageError;
use crate::domain::notes::failed;

use super::colors::{display_hex, event_color_from_id};
use super::locale_compare;
use super::projection::provider_supports_write;

/// Every live source (`includeArchived` false), accounts first, then by title.
pub fn sources(conn: &Connection) -> Result<Vec<CalendarSourceRecord>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.provider, c.kind, c.account_id, c.remote_id, c.title, c.timezone,
                    c.color, c.is_primary, c.is_selected, c.is_memry_managed, c.sync_status,
                    c.last_synced_at, json_extract(s.payload, '$.lastError'), c.metadata,
                    c.archived_at, c.sync_cursor
               FROM calendar_sources c
               LEFT JOIN sync_items s ON s.item_type = 'calendar_source' AND s.item_id = c.id
              WHERE c.deleted_at IS NULL AND c.archived_at IS NULL",
        )
        .map_err(failed)?;
    let mut rows: Vec<CalendarSourceRecord> = stmt
        .query_map([], |row| {
            Ok(CalendarSourceRecord {
                id: row.get(0)?,
                provider: row.get(1)?,
                kind: row.get(2)?,
                account_id: row.get(3)?,
                remote_id: row.get(4)?,
                title: row.get(5)?,
                timezone: row.get(6)?,
                color: display_hex(row.get::<_, Option<String>>(7)?.as_deref()),
                is_primary: row.get::<_, i64>(8)? != 0,
                is_selected: row.get::<_, i64>(9)? != 0,
                is_memry_managed: row.get::<_, i64>(10)? != 0,
                sync_status: row.get(11)?,
                last_synced_at: row.get(12)?,
                last_error: row.get(13)?,
                metadata_json: row.get(14)?,
                archived_at: row.get(15)?,
                sync_cursor: row.get(16)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    rows.sort_by(|a, b| {
        let rank = |s: &CalendarSourceRecord| u8::from(s.kind != "account");
        rank(a)
            .cmp(&rank(b))
            .then_with(|| locale_compare(&a.title, &b.title))
    });
    Ok(rows)
}

/// The live binding of an item: the oldest by `createdAt`, then id
/// (`findLiveBinding`).
pub fn live_binding(
    conn: &Connection,
    source_type: &str,
    source_id: &str,
) -> Result<Option<CalendarItemBinding>, StorageError> {
    conn.query_row(
        "SELECT provider, remote_calendar_id, remote_event_id, ownership_mode, writeback_mode
           FROM calendar_bindings
          WHERE deleted_at IS NULL AND archived_at IS NULL AND source_type = ?1 AND source_id = ?2
          ORDER BY created_at_raw, id LIMIT 1",
        [source_type, source_id],
        |row| {
            Ok(CalendarItemBinding {
                provider: row.get(0)?,
                remote_calendar_id: row.get(1)?,
                remote_event_id: row.get(2)?,
                ownership_mode: row.get(3)?,
                writeback_mode: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

/// `GET_EVENT`.
pub fn event(conn: &Connection, id: &str) -> Result<Option<CalendarEventRecord>, StorageError> {
    let row = conn
        .query_row(
            "SELECT id, title, description, location, start_at, end_at, timezone, is_all_day,
                    recurrence_rule, attendees, reminders, visibility, color_id, conference_data,
                    target_calendar_id, created_at, modified_at
               FROM calendar_events WHERE id = ?1 AND deleted_at IS NULL",
            [id],
            |row| {
                let color_id: Option<String> = row.get(12)?;
                Ok(CalendarEventRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    location: row.get(3)?,
                    start_at: row.get(4)?,
                    end_at: row.get(5)?,
                    timezone: row.get(6)?,
                    is_all_day: row.get::<_, i64>(7)? != 0,
                    recurrence_rule_json: row.get(8)?,
                    attendees_json: row.get(9)?,
                    reminders_json: row.get(10)?,
                    visibility: row.get(11)?,
                    color: event_color_from_id(color_id.as_deref()).map(str::to_owned),
                    color_id,
                    conference_data_json: row.get(13)?,
                    target_calendar_id: row.get(14)?,
                    binding: None,
                    created_at: row.get(15)?,
                    modified_at: row.get(16)?,
                })
            },
        )
        .optional()
        .map_err(failed)?;
    let Some(mut record) = row else {
        return Ok(None);
    };
    record.binding = live_binding(conn, "event", id)?;
    Ok(Some(record))
}

/// `getExternalEventDetails`; also reads the device-local mirror.
pub fn external_event(
    conn: &Connection,
    id: &str,
) -> Result<Option<CalendarExternalEventRecord>, StorageError> {
    for (table, synced) in [
        ("calendar_external_events", true),
        ("calendar_local_events", false),
    ] {
        let live = if synced {
            "AND e.deleted_at IS NULL"
        } else {
            ""
        };
        let sql = format!(
            "SELECT e.id, e.title, e.description, e.location, e.start_at, e.end_at, e.timezone,
                    e.is_all_day, e.status, e.recurrence_rule, e.attendees, e.reminders,
                    e.conference_data, s.id, s.provider, s.title, s.color, s.metadata
               FROM {table} e
               LEFT JOIN calendar_sources s ON s.id = e.source_id AND s.deleted_at IS NULL
              WHERE e.id = ?1 {live}"
        );
        let found = conn
            .query_row(&sql, [id], |row| {
                let provider: Option<String> = row.get(14)?;
                let metadata: Option<String> = row.get(17)?;
                let account_title = metadata
                    .and_then(|m| serde_json::from_str::<Value>(&m).ok())
                    .and_then(|m| {
                        m.get("sourceTitle")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                    });
                Ok(CalendarExternalEventRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    location: row.get(3)?,
                    start_at: row.get(4)?,
                    end_at: row.get(5)?,
                    timezone: row.get(6)?,
                    is_all_day: row.get::<_, i64>(7)? != 0,
                    status: row.get(8)?,
                    recurrence_rule_json: row.get(9)?,
                    attendees_json: row.get(10)?,
                    reminders_json: row.get(11)?,
                    conference_data_json: row.get(12)?,
                    source_id: row.get(13)?,
                    is_promotable: synced
                        && provider.as_deref().is_some_and(provider_supports_write),
                    source_provider: provider,
                    source_title: row.get(15)?,
                    source_color: row.get(16)?,
                    account_title,
                })
            })
            .optional()
            .map_err(failed)?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

/// Projects whose `links` name this event (`listForItem('calendar_event')`).
pub fn linked_projects(
    conn: &Connection,
    event_id: &str,
) -> Result<Vec<CalendarLinkedProject>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT p.id, p.name, p.color, p.archived_at IS NOT NULL
               FROM project_links l JOIN projects p ON p.id = l.project_id
              WHERE l.deleted_at IS NULL AND p.deleted_at IS NULL
                AND l.item_type = 'calendar_event' AND l.item_id = ?1
              ORDER BY p.name",
        )
        .map_err(failed)?;
    let rows = stmt
        .query_map([event_id], |row| {
            Ok(CalendarLinkedProject {
                id: row.get(0)?,
                name: row.get(1)?,
                color: row.get(2)?,
                is_archived: row.get(3)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}
