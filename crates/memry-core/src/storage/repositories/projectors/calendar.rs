//! The four calendar types (spec 007 CL010): `calendar_source`,
//! `calendar_event`, `calendar_external_event`, `calendar_binding`
//! (`packages/contracts/src/sync-payloads.ts:371-470`, migration `0005`).
//!
//! Every field is `opt_null` ([`super`]'s rule): a projector substitutes and
//! never refuses. Enum-valued keys are read as plain text for the same reason:
//! a value a newer desktop adds must project, not fail the row. The merge rules
//! (desktop's `??` overlay, presence keys, the field merge on events) run on
//! the write path ([`crate::domain::calendar_items::merge`]) before anything
//! reaches a column.
//!
//! Time columns stay verbatim TEXT (see the migration): the projection compares
//! and sorts them as strings, exactly as desktop's SQL does.

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;

use super::super::schema::{Field, Kind, Object, ProjectionError, read_fields};
use super::{
    ItemContext, clock_text, failed, field_clocks_text, flag, instant, json, text, text_or_default,
};

const SOURCE_FIELDS: &[Field] = &[
    Field::opt_null("provider", Kind::Text),
    Field::opt_null("kind", Kind::Text),
    Field::opt_null("accountId", Kind::Text),
    Field::opt_null("remoteId", Kind::Text),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("timezone", Kind::Text),
    Field::opt_null("color", Kind::Text),
    Field::opt_null("isPrimary", Kind::Bool),
    Field::opt_null("isSelected", Kind::Bool),
    Field::opt_null("isMemryManaged", Kind::Bool),
    Field::opt_null("syncCursor", Kind::Text),
    Field::opt_null("syncStatus", Kind::Text),
    Field::opt_null("lastSyncedAt", Kind::Text),
    Field::opt_null("metadata", Kind::Any),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

const EVENT_FIELDS: &[Field] = &[
    Field::opt_null("title", Kind::Text),
    Field::opt_null("description", Kind::Text),
    Field::opt_null("location", Kind::Text),
    Field::opt_null("startAt", Kind::Text),
    Field::opt_null("endAt", Kind::Text),
    Field::opt_null("timezone", Kind::Text),
    Field::opt_null("isAllDay", Kind::Bool),
    Field::opt_null("recurrenceRule", Kind::Any),
    Field::opt_null("recurrenceExceptions", Kind::Any),
    Field::opt_null("attendees", Kind::Any),
    Field::opt_null("reminders", Kind::Any),
    Field::opt_null("visibility", Kind::Text),
    Field::opt_null("colorId", Kind::Text),
    Field::opt_null("conferenceData", Kind::Any),
    Field::opt_null("parentEventId", Kind::Text),
    Field::opt_null("originalStartTime", Kind::Text),
    Field::opt_null("targetCalendarId", Kind::Text),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("fieldClocks", Kind::ClockMap),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

const EXTERNAL_FIELDS: &[Field] = &[
    Field::opt_null("sourceId", Kind::Text),
    Field::opt_null("remoteEventId", Kind::Text),
    Field::opt_null("remoteEtag", Kind::Text),
    Field::opt_null("remoteUpdatedAt", Kind::Text),
    Field::opt_null("title", Kind::Text),
    Field::opt_null("description", Kind::Text),
    Field::opt_null("location", Kind::Text),
    Field::opt_null("startAt", Kind::Text),
    Field::opt_null("endAt", Kind::Text),
    Field::opt_null("timezone", Kind::Text),
    Field::opt_null("isAllDay", Kind::Bool),
    Field::opt_null("status", Kind::Text),
    Field::opt_null("recurrenceRule", Kind::Any),
    Field::opt_null("attendees", Kind::Any),
    Field::opt_null("reminders", Kind::Any),
    Field::opt_null("visibility", Kind::Text),
    Field::opt_null("colorId", Kind::Text),
    Field::opt_null("conferenceData", Kind::Any),
    Field::opt_null("rawPayload", Kind::Any),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

const BINDING_FIELDS: &[Field] = &[
    Field::opt_null("sourceType", Kind::Text),
    Field::opt_null("sourceId", Kind::Text),
    Field::opt_null("provider", Kind::Text),
    Field::opt_null("remoteCalendarId", Kind::Text),
    Field::opt_null("remoteEventId", Kind::Text),
    Field::opt_null("ownershipMode", Kind::Text),
    Field::opt_null("writebackMode", Kind::Text),
    Field::opt_null("remoteVersion", Kind::Text),
    Field::opt_null("lastLocalSnapshot", Kind::Any),
    Field::opt_null("archivedAt", Kind::Text),
    Field::opt_null("clock", Kind::Clock),
    Field::opt_null("createdAt", Kind::SyncTimestamp),
    Field::opt_null("modifiedAt", Kind::SyncTimestamp),
];

pub fn read_source(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("calendar_source", parsed, SOURCE_FIELDS)
}

pub fn read_event(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("calendar_event", parsed, EVENT_FIELDS)
}

pub fn read_external_event(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("calendar_external_event", parsed, EXTERNAL_FIELDS)
}

pub fn read_binding(parsed: &Object) -> Result<Object, ProjectionError> {
    read_fields("calendar_binding", parsed, BINDING_FIELDS)
}

/// Desktop's insert defaults (`calendar-source-handler.ts`): provider
/// `google`, kind `calendar`, remote id = item id, `Untitled calendar`, `idle`.
pub fn project_source(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT OR REPLACE INTO calendar_sources (
             id, provider, kind, account_id, remote_id, title, timezone, color,
             is_primary, is_selected, is_memry_managed, sync_cursor, sync_status,
             last_synced_at, last_error, metadata, archived_at, created_at,
             modified_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
        params![
            item.item_id,
            text_or_default(view, "provider", "google"),
            text_or_default(view, "kind", "calendar"),
            text(view, "accountId"),
            text_or_default(view, "remoteId", item.item_id),
            text_or_default(view, "title", "Untitled calendar"),
            text(view, "timezone"),
            text(view, "color"),
            flag(view, "isPrimary").unwrap_or(0),
            flag(view, "isSelected").unwrap_or(0),
            flag(view, "isMemryManaged").unwrap_or(0),
            text(view, "syncCursor"),
            text_or_default(view, "syncStatus", "idle"),
            text(view, "lastSyncedAt"),
            // Not a schema key (the reader mirrors the schema); the source
            // queries read desktop's pushed `lastError` from the verbatim payload.
            Option::<String>::None,
            json(view, "metadata"),
            text(view, "archivedAt"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Desktop's insert defaults (`calendar-event-handler.ts`): `Untitled event`,
/// `startAt` = the apply instant, timezone `UTC`.
pub fn project_event(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let fallback_start =
        crate::storage::repositories::instants::to_iso8601(item.synced_at).unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO calendar_events (
             id, title, description, location, start_at, end_at, timezone,
             is_all_day, recurrence_rule, recurrence_exceptions, attendees,
             reminders, visibility, color_id, conference_data, parent_event_id,
             original_start_time, target_calendar_id, archived_at, created_at,
             modified_at, clock, field_clocks, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)",
        params![
            item.item_id,
            text_or_default(view, "title", "Untitled event"),
            text(view, "description"),
            text(view, "location"),
            text(view, "startAt").unwrap_or(fallback_start),
            text(view, "endAt"),
            text_or_default(view, "timezone", "UTC"),
            flag(view, "isAllDay").unwrap_or(0),
            json(view, "recurrenceRule"),
            json(view, "recurrenceExceptions"),
            json(view, "attendees"),
            json(view, "reminders"),
            text(view, "visibility"),
            text(view, "colorId"),
            json(view, "conferenceData"),
            text(view, "parentEventId"),
            text(view, "originalStartTime"),
            text(view, "targetCalendarId"),
            text(view, "archivedAt"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            field_clocks_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Desktop's insert defaults (`calendar-external-event-handler.ts`):
/// `Untitled imported event`, `confirmed`, remote id = item id. A missing
/// `sourceId` projects as the empty id, which joins no source and so never
/// shows (desktop refuses the row; here it waits, harmlessly, in the payload).
pub fn project_external_event(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    let fallback_start =
        crate::storage::repositories::instants::to_iso8601(item.synced_at).unwrap_or_default();
    conn.execute(
        "INSERT OR REPLACE INTO calendar_external_events (
             id, source_id, remote_event_id, remote_etag, remote_updated_at, title,
             description, location, start_at, end_at, timezone, is_all_day, status,
             recurrence_rule, attendees, reminders, visibility, color_id,
             conference_data, raw_payload, archived_at, created_at, modified_at,
             clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26)",
        params![
            item.item_id,
            text_or_default(view, "sourceId", ""),
            text_or_default(view, "remoteEventId", item.item_id),
            text(view, "remoteEtag"),
            text(view, "remoteUpdatedAt"),
            text_or_default(view, "title", "Untitled imported event"),
            text(view, "description"),
            text(view, "location"),
            text(view, "startAt").unwrap_or(fallback_start),
            text(view, "endAt"),
            text(view, "timezone"),
            flag(view, "isAllDay").unwrap_or(0),
            text_or_default(view, "status", "confirmed"),
            json(view, "recurrenceRule"),
            json(view, "attendees"),
            json(view, "reminders"),
            text(view, "visibility"),
            text(view, "colorId"),
            json(view, "conferenceData"),
            json(view, "rawPayload"),
            text(view, "archivedAt"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}

/// Desktop's insert defaults (`calendar-binding-handler.ts`): `event`,
/// source id = item id, `google`, `primary`, remote id = item id,
/// `memry_managed`, `broad`.
pub fn project_binding(
    conn: &Connection,
    item: ItemContext<'_>,
    view: &Object,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT OR REPLACE INTO calendar_bindings (
             id, source_type, source_id, provider, remote_calendar_id,
             remote_event_id, ownership_mode, writeback_mode, remote_version,
             last_local_snapshot, archived_at, created_at_raw, created_at,
             modified_at, clock, synced_at, deleted_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
                   ?15, ?16, ?17)",
        params![
            item.item_id,
            text_or_default(view, "sourceType", "event"),
            text_or_default(view, "sourceId", item.item_id),
            text_or_default(view, "provider", "google"),
            text_or_default(view, "remoteCalendarId", "primary"),
            text_or_default(view, "remoteEventId", item.item_id),
            text_or_default(view, "ownershipMode", "memry_managed"),
            text_or_default(view, "writebackMode", "broad"),
            text(view, "remoteVersion"),
            json(view, "lastLocalSnapshot"),
            text(view, "archivedAt"),
            text(view, "createdAt"),
            instant(view, "createdAt"),
            instant(view, "modifiedAt"),
            clock_text(view),
            item.synced_at,
            item.deleted_at,
        ],
    )
    .map_err(failed)?;
    Ok(())
}
