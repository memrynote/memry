//! Stage 36d1, the calendar and bookmarks. Each synced row becomes the record its handler pushes
//! (`buildPushPayload`, key for key). Where a row lives follows Electron's provider scopes
//! (`calendar/provider/capabilities.ts`): an EventKit calendar never leaves the Mac and the core
//! has no EventKit provider, so its source and mirrored events are dropped and counted; the
//! events of an ICS feed (`mirrorScope: 'device'`) go to `calendar_local_events`, which the core
//! keeps per device as Electron does. Every other mirror syncs, as the shared handlers decide
//! (`DEVICE_LOCAL_CALENDAR_PROVIDERS`, `calendar-api.ts:318`): an unknown provider's events and
//! events whose source is gone included.

use memry_core::storage::import::ImportLocalEvent;
use memry_core::storage::repositories::instants::to_epoch_ms;
use rusqlite::Row;
use serde_json::Value;

use super::inbox::{Columns, Kind, payload_records, push_dropped, refuse_unreplayed};
use super::records::malformed;
use super::row_dumps::column;
use super::tags::drizzle_bool;
use super::{SourceDb, TableStats};
use crate::electron_import::vault_db::source::source_error;
use crate::electron_import::vault_db::{ImportError, TableCtx, read_source_id};

const EVENTKIT: &str = "'apple-eventkit'";
/// `DEVICE_LOCAL_CALENDAR_PROVIDERS.mirrors`: providers whose events never sync.
const DEVICE_MIRRORS: &str = "('ics', 'apple-eventkit')";

/// `calendar-source-handler.ts` `buildPushPayload`. `last_error` stays on the device.
const SOURCE_COLUMNS: Columns = &[
    ("provider", "provider", Kind::Plain),
    ("kind", "kind", Kind::Plain),
    ("accountId", "account_id", Kind::Plain),
    ("remoteId", "remote_id", Kind::Plain),
    ("title", "title", Kind::Plain),
    ("timezone", "timezone", Kind::Plain),
    ("color", "color", Kind::Plain),
    ("isPrimary", "is_primary", Kind::Bool),
    ("isSelected", "is_selected", Kind::Bool),
    ("isMemryManaged", "is_memry_managed", Kind::Bool),
    ("syncCursor", "sync_cursor", Kind::Plain),
    ("syncStatus", "sync_status", Kind::Plain),
    ("lastSyncedAt", "last_synced_at", Kind::Plain),
    ("metadata", "metadata", Kind::Json),
    ("archivedAt", "archived_at", Kind::Plain),
    ("clock", "clock", Kind::JsonOrAbsent),
    ("createdAt", "created_at", Kind::Plain),
    ("modifiedAt", "modified_at", Kind::Plain),
];

/// `calendar-event-handler.ts:210-244`.
const EVENT_COLUMNS: Columns = &[
    ("title", "title", Kind::Plain),
    ("description", "description", Kind::Plain),
    ("location", "location", Kind::Plain),
    ("startAt", "start_at", Kind::Plain),
    ("endAt", "end_at", Kind::Plain),
    ("timezone", "timezone", Kind::Plain),
    ("isAllDay", "is_all_day", Kind::Bool),
    ("recurrenceRule", "recurrence_rule", Kind::Json),
    ("recurrenceExceptions", "recurrence_exceptions", Kind::Json),
    ("attendees", "attendees", Kind::Json),
    ("reminders", "reminders", Kind::Json),
    ("visibility", "visibility", Kind::Plain),
    ("colorId", "color_id", Kind::Plain),
    ("conferenceData", "conference_data", Kind::Json),
    ("archivedAt", "archived_at", Kind::Plain),
    ("targetCalendarId", "target_calendar_id", Kind::Plain),
    ("parentEventId", "parent_event_id", Kind::Plain),
    ("originalStartTime", "original_start_time", Kind::Plain),
    ("clock", "clock", Kind::JsonOrAbsent),
    ("fieldClocks", "field_clocks", Kind::JsonOrAbsent),
    ("createdAt", "created_at", Kind::Plain),
    ("modifiedAt", "modified_at", Kind::Plain),
];

/// `calendar-binding-handler.ts` `buildPushPayload`.
const BINDING_COLUMNS: Columns = &[
    ("sourceType", "source_type", Kind::Plain),
    ("sourceId", "source_id", Kind::Plain),
    ("provider", "provider", Kind::Plain),
    ("remoteCalendarId", "remote_calendar_id", Kind::Plain),
    ("remoteEventId", "remote_event_id", Kind::Plain),
    ("ownershipMode", "ownership_mode", Kind::Plain),
    ("writebackMode", "writeback_mode", Kind::Plain),
    ("remoteVersion", "remote_version", Kind::Plain),
    ("lastLocalSnapshot", "last_local_snapshot", Kind::Json),
    ("archivedAt", "archived_at", Kind::Plain),
    ("clock", "clock", Kind::JsonOrAbsent),
    ("createdAt", "created_at", Kind::Plain),
    ("modifiedAt", "modified_at", Kind::Plain),
];

/// `calendar-external-event-handler.ts` `buildPushPayload`. A row without a clock is sent
/// without one here; Electron stamps its first clock only when it pushes the row (#1215).
const EXTERNAL_COLUMNS: Columns = &[
    ("sourceId", "source_id", Kind::Plain),
    ("remoteEventId", "remote_event_id", Kind::Plain),
    ("remoteEtag", "remote_etag", Kind::Plain),
    ("remoteUpdatedAt", "remote_updated_at", Kind::Plain),
    ("title", "title", Kind::Plain),
    ("description", "description", Kind::Plain),
    ("location", "location", Kind::Plain),
    ("startAt", "start_at", Kind::Plain),
    ("endAt", "end_at", Kind::Plain),
    ("timezone", "timezone", Kind::Plain),
    ("isAllDay", "is_all_day", Kind::Bool),
    ("status", "status", Kind::Plain),
    ("recurrenceRule", "recurrence_rule", Kind::Json),
    ("attendees", "attendees", Kind::Json),
    ("reminders", "reminders", Kind::Json),
    ("visibility", "visibility", Kind::Plain),
    ("colorId", "color_id", Kind::Plain),
    ("conferenceData", "conference_data", Kind::Json),
    ("rawPayload", "raw_payload", Kind::Json),
    ("archivedAt", "archived_at", Kind::Plain),
    ("clock", "clock", Kind::JsonOrAbsent),
    ("createdAt", "created_at", Kind::Plain),
    ("modifiedAt", "modified_at", Kind::Plain),
];

/// The bookmark handler pushes the drizzle row (`JSON.stringify(bookmark)`), schema order.
const BOOKMARK_COLUMNS: Columns = &[
    ("id", "id", Kind::Plain),
    ("itemType", "item_type", Kind::Plain),
    ("itemId", "item_id", Kind::Plain),
    ("position", "position", Kind::Plain),
    ("createdAt", "created_at", Kind::Plain),
    ("clock", "clock", Kind::Json),
    ("syncedAt", "synced_at", Kind::Plain),
];

fn count(ctx: &TableCtx<'_>, sql: &str) -> Result<u64, ImportError> {
    ctx.source
        .query_row(sql, [], |row| row.get::<_, i64>(0))
        .map(|n| n as u64)
        .map_err(|e| source_error(SourceDb::Data, e))
}

pub fn calendar_sources(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    refuse_unreplayed(
        ctx,
        "calendar_sources",
        &format!("clock IS NULL AND provider IS NOT {EVENTKIT}"),
    )?;
    let eventkit = count(
        ctx,
        &format!("SELECT count(*) FROM calendar_sources WHERE provider = {EVENTKIT}"),
    )?;
    let mut stats = payload_records(
        ctx,
        "calendar_sources",
        "calendar_source",
        SOURCE_COLUMNS,
        &format!("WHERE provider IS NOT {EVENTKIT}"),
    )?;
    push_dropped(&mut stats, "eventkitCalendars", eventkit);
    Ok(stats)
}

pub fn calendar_events(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    refuse_unreplayed(ctx, "calendar_events", "clock IS NULL")?;
    payload_records(ctx, "calendar_events", "calendar_event", EVENT_COLUMNS, "")
}

pub fn calendar_bindings(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    refuse_unreplayed(ctx, "calendar_bindings", "clock IS NULL")?;
    payload_records(
        ctx,
        "calendar_bindings",
        "calendar_binding",
        BINDING_COLUMNS,
        "",
    )
}

/// Electron's dirty sweep re-pushes a clocked bookmark never synced (`dirty-recovery.ts:330`),
/// and its seed an unclocked one.
pub fn bookmarks(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    refuse_unreplayed(ctx, "bookmarks", "clock IS NULL OR synced_at IS NULL")?;
    payload_records(ctx, "bookmarks", "bookmark", BOOKMARK_COLUMNS, "")
}

/// Synced mirrors become records; an ICS feed's live events go to `calendar_local_events` (its
/// archived ones are gone from the feed and dropped).
pub fn calendar_external_events(ctx: &mut TableCtx<'_>) -> Result<TableStats, ImportError> {
    const TABLE: &str = "calendar_external_events";
    refuse_unreplayed(
        ctx,
        TABLE,
        &format!(
            "clock IS NULL AND source_id NOT IN \
             (SELECT id FROM calendar_sources WHERE provider IN {DEVICE_MIRRORS})"
        ),
    )?;
    let of_provider = |condition: &str| {
        format!(
            "SELECT count(*) FROM calendar_external_events e
               JOIN calendar_sources s ON s.id = e.source_id WHERE {condition}"
        )
    };
    let eventkit = count(ctx, &of_provider(&format!("s.provider = {EVENTKIT}")))?;
    let archived = count(
        ctx,
        &of_provider("s.provider = 'ics' AND e.archived_at IS NOT NULL"),
    )?;
    let mut stats = payload_records(
        ctx,
        TABLE,
        "calendar_external_event",
        EXTERNAL_COLUMNS,
        &format!(
            "WHERE source_id NOT IN (SELECT id FROM calendar_sources WHERE provider IN {DEVICE_MIRRORS})"
        ),
    )?;
    let local = local_events(ctx)?;
    ctx.writer.put_local_events(&local)?;
    stats.written += local.len() as u64;
    push_dropped(&mut stats, "eventkitEvents", eventkit);
    push_dropped(&mut stats, "archivedFeedEvents", archived);
    Ok(stats)
}

fn local_events(ctx: &TableCtx<'_>) -> Result<Vec<ImportLocalEvent>, ImportError> {
    const TABLE: &str = "calendar_external_events";
    let mut stmt = ctx
        .source
        .prepare(
            "SELECT e.rowid, e.id, e.source_id, e.remote_event_id, e.title, e.description,
                    e.location, e.start_at, e.end_at, e.timezone, e.is_all_day, e.status,
                    e.recurrence_rule, e.attendees, e.reminders, e.conference_data,
                    e.raw_payload, e.modified_at
               FROM calendar_external_events e JOIN calendar_sources s ON s.id = e.source_id
              WHERE s.provider = 'ics' AND e.archived_at IS NULL",
        )
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| source_error(SourceDb::Data, e))?;
    let mut events = Vec::new();
    while let Some(row) = rows.next().map_err(|e| source_error(SourceDb::Data, e))? {
        let rowid: i64 = row
            .get("rowid")
            .map_err(|e| source_error(SourceDb::Data, e))?;
        let text = |name| optional_text(row, name, rowid);
        let required = |name| {
            optional_text(row, name, rowid)?
                .ok_or_else(|| malformed(TABLE, rowid, "a required column is empty"))
        };
        let modified_at = text("modified_at")?
            .map(|iso| {
                to_epoch_ms(&iso)
                    .ok_or_else(|| malformed(TABLE, rowid, "modified_at is not an ISO instant"))
            })
            .transpose()?;
        events.push(ImportLocalEvent {
            id: read_source_id(row, SourceDb::Data, TABLE, "id")?,
            source_id: read_source_id(row, SourceDb::Data, TABLE, "source_id")?,
            remote_event_id: required("remote_event_id")?,
            title: required("title")?,
            description: text("description")?,
            location: text("location")?,
            start_at: required("start_at")?,
            end_at: text("end_at")?,
            timezone: text("timezone")?,
            is_all_day: drizzle_bool(column(row, "is_all_day", TABLE, rowid)?) == Value::Bool(true),
            status: required("status")?,
            recurrence_rule: text("recurrence_rule")?,
            attendees: text("attendees")?,
            reminders: text("reminders")?,
            conference_data: text("conference_data")?,
            raw_payload: text("raw_payload")?,
            modified_at,
        });
    }
    Ok(events)
}

fn optional_text(row: &Row<'_>, name: &str, rowid: i64) -> Result<Option<String>, ImportError> {
    const TABLE: &str = "calendar_external_events";
    match column(row, name, TABLE, rowid)? {
        Value::Null => Ok(None),
        Value::String(text) => Ok(Some(text)),
        _ => Err(malformed(TABLE, rowid, "a text column holds a number")),
    }
}
