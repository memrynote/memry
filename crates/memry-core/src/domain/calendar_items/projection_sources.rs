//! The projection's second half (split from [`super::projection`] at the
//! 600-line ceiling): reminders, date reminders, inbox snoozes, imported
//! events and notes — `projection.ts`'s loaders from `loadReminderItems` on.

use std::collections::{HashMap, HashSet};

use rusqlite::{Connection, params_from_iter};
use serde_json::Value;

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

use super::colors::display_hex;
use super::projection::{
    Editability, ProjectionItem, RangeInput, SourceMeta, bindings_by_source, description_preview,
    event_colors, iso, local_all_day_end, local_day_of, local_instant, native_source,
};
use super::zone::{LocalZone, local_date};

struct ReminderRow {
    id: String,
    target_id: String,
    remind_at: String,
    anchor_id: Option<String>,
    highlight_text: Option<String>,
    title: Option<String>,
    note: Option<String>,
    status: String,
    snoozed_until: Option<String>,
}

fn reminder_rows(
    conn: &Connection,
    note_date: bool,
    input: &RangeInput,
) -> Result<Vec<ReminderRow>, StorageError> {
    // Regular reminders: pending by remindAt or snoozed by snoozedUntil.
    // `note_date` ones: every non-snoozed status by remindAt, snoozed by
    // snoozedUntil (they persist after firing).
    let sql = if note_date {
        "SELECT id, target_id, remind_at, anchor_id, highlight_text, title, note, status, snoozed_until
           FROM reminders
          WHERE deleted_at IS NULL AND target_type = 'note_date'
            AND ((status != 'snoozed' AND remind_at >= ?1 AND remind_at < ?2)
              OR (status = 'snoozed' AND snoozed_until IS NOT NULL
                  AND snoozed_until >= ?1 AND snoozed_until < ?2))
          ORDER BY remind_at"
    } else {
        "SELECT id, target_id, remind_at, anchor_id, highlight_text, title, note, status, snoozed_until
           FROM reminders
          WHERE deleted_at IS NULL AND target_type != 'note_date'
            AND ((status = 'pending' AND remind_at >= ?1 AND remind_at < ?2)
              OR (status = 'snoozed' AND snoozed_until IS NOT NULL
                  AND snoozed_until >= ?1 AND snoozed_until < ?2))
          ORDER BY remind_at"
    };
    let mut stmt = conn.prepare(sql).map_err(failed)?;
    let rows = stmt
        .query_map([&input.start_at, &input.end_at], |row| {
            Ok(ReminderRow {
                id: row.get(0)?,
                target_id: row.get(1)?,
                remind_at: row.get(2)?,
                anchor_id: row.get(3)?,
                highlight_text: row.get(4)?,
                title: row.get(5)?,
                note: row.get(6)?,
                status: row.get(7)?,
                snoozed_until: row.get(8)?,
            })
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}

/// `(effectiveStartAt, snoozeOffsetMinutes)`.
fn snooze_position(row: &ReminderRow) -> (String, Option<i64>) {
    match row
        .snoozed_until
        .as_deref()
        .filter(|_| row.status == "snoozed")
    {
        Some(until) if !until.is_empty() => {
            let offset = match (
                instants::to_epoch_ms(until),
                instants::to_epoch_ms(&row.remind_at),
            ) {
                // `Math.round` rounds half up, toward +infinity.
                (Some(a), Some(b)) => Some(((a - b) as f64 / 60_000.0 + 0.5).floor() as i64),
                _ => None,
            };
            (until.to_owned(), offset)
        }
        _ => (row.remind_at.clone(), None),
    }
}

pub(crate) fn reminders(
    conn: &Connection,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let rows = reminder_rows(conn, false, input)?;
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let bindings = bindings_by_source(conn, "reminder", &ids)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let (start, offset) = snooze_position(&row);
            let title = row
                .title
                .as_deref()
                .map(str::trim)
                .filter(|t| !t.is_empty())
                .unwrap_or("Reminder")
                .to_owned();
            ProjectionItem {
                projection_id: format!("reminder:{}", row.id),
                source_type: "reminder".to_owned(),
                binding: bindings.get(&row.id).cloned(),
                description_preview: description_preview(
                    row.note.as_deref().or(row.highlight_text.as_deref()),
                ),
                source_id: row.id,
                title,
                start_at: start,
                end_at: None,
                is_all_day: false,
                timezone: input.local_timezone.clone(),
                visual_type: "reminder".to_owned(),
                editability: Editability::MOVE_TEXT_DELETE,
                source: native_source("memrynote Reminders"),
                snooze_offset_minutes: offset,
                color: None,
                display_color: None,
                note_id: None,
                anchor_id: None,
                is_triggered: None,
            }
        })
        .collect())
}

fn note_titles(conn: &Connection, ids: &[String]) -> Result<HashMap<String, String>, StorageError> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!("SELECT id, title FROM notes WHERE id IN ({placeholders})");
    let mut stmt = conn.prepare(&sql).map_err(failed)?;
    let rows = stmt
        .query_map(params_from_iter(ids.iter()), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(failed)?;
    for row in rows {
        let (id, title) = row.map_err(failed)?;
        out.insert(id, title);
    }
    Ok(out)
}

pub(crate) fn note_date_reminders(
    conn: &Connection,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let rows = reminder_rows(conn, true, input)?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut note_ids: Vec<String> = rows.iter().map(|r| r.target_id.clone()).collect();
    note_ids.sort();
    note_ids.dedup();
    let titles = note_titles(conn, &note_ids)?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let (start, offset) = snooze_position(&row);
            let title = titles
                .get(&row.target_id)
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .unwrap_or("Untitled")
                .to_owned();
            ProjectionItem {
                projection_id: format!("note_date:{}", row.id),
                source_type: "note_date".to_owned(),
                description_preview: description_preview(row.note.as_deref()),
                is_triggered: Some(row.status == "triggered" || row.status == "dismissed"),
                source_id: row.id,
                title,
                start_at: start,
                end_at: None,
                is_all_day: false,
                timezone: input.local_timezone.clone(),
                visual_type: "note_date".to_owned(),
                editability: Editability::NONE,
                source: native_source("memrynote Notes"),
                binding: None,
                snooze_offset_minutes: offset,
                color: None,
                display_color: None,
                note_id: Some(row.target_id),
                anchor_id: row.anchor_id,
            }
        })
        .collect())
}

pub(crate) fn inbox_snoozes(
    conn: &Connection,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let (Some(start), Some(end)) = (
        instants::to_epoch_ms(&input.start_at),
        instants::to_epoch_ms(&input.end_at),
    ) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare(
            "SELECT i.id, i.title, i.content, i.snoozed_until,
                    json_extract(s.payload, '$.snoozedUntil')
               FROM inbox_items i
               LEFT JOIN sync_items s ON s.item_type = 'inbox' AND s.item_id = i.id
              WHERE i.deleted_at IS NULL AND i.snoozed_until IS NOT NULL
                AND i.snoozed_until >= ?1 AND i.snoozed_until < ?2
                AND i.filed_at IS NULL AND i.archived_at IS NULL
              ORDER BY i.snoozed_until",
        )
        .map_err(failed)?;
    let rows: Vec<SnoozeRow> = stmt
        .query_map([start, end], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let bindings = bindings_by_source(conn, "inbox_snooze", &ids)?;
    Ok(rows
        .into_iter()
        .map(|(id, title, content, until_ms, until_raw)| ProjectionItem {
            projection_id: format!("inbox_snooze:{id}"),
            source_type: "inbox_snooze".to_owned(),
            binding: bindings.get(&id).cloned(),
            source_id: id,
            title,
            description_preview: description_preview(content.as_deref()),
            start_at: until_raw.unwrap_or_else(|| iso(until_ms)),
            end_at: None,
            is_all_day: false,
            timezone: input.local_timezone.clone(),
            visual_type: "snooze".to_owned(),
            editability: Editability {
                can_move: true,
                can_resize: false,
                can_edit_text: false,
                can_delete: true,
            },
            source: native_source("memrynote Inbox"),
            snooze_offset_minutes: None,
            color: None,
            display_color: None,
            note_id: None,
            anchor_id: None,
            is_triggered: None,
        })
        .collect())
}

/// Providers with a write path (`provider/capabilities.ts` `supportsWrite`).
pub fn provider_supports_write(provider: &str) -> bool {
    matches!(provider, "google" | "caldav")
}

pub(crate) fn external_events(
    conn: &Connection,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let mut items = Vec::new();
    // Synced mirrors, then the device-local ones (ICS), same rules.
    for table in ["calendar_external_events", "calendar_local_events"] {
        let synced = table == "calendar_external_events";
        let sql =
            format!(
            "SELECT e.id, e.title, e.description, e.start_at, e.end_at, e.is_all_day, e.timezone,
                    {color}, s.id, s.provider, s.title, s.color, s.kind, s.is_memry_managed,
                    s.timezone
               FROM {table} e
               JOIN calendar_sources s ON s.id = e.source_id
              WHERE {live} s.deleted_at IS NULL AND s.archived_at IS NULL
                AND e.start_at < ?1 AND coalesce(e.end_at, e.start_at) >= ?2
                {selected}
              ORDER BY e.start_at",
            color = if synced { "e.color_id" } else { "NULL" },
            live = if synced { "e.deleted_at IS NULL AND e.archived_at IS NULL AND" } else { "" },
            selected = if input.include_unselected_sources { "" } else { "AND s.is_selected = 1" },
        );
        let mut stmt = conn.prepare(&sql).map_err(failed)?;
        let rows = stmt
            .query_map([&input.end_at, &input.start_at], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)? != 0,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, String>(9)?,
                    row.get::<_, String>(10)?,
                    row.get::<_, Option<String>>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, i64>(13)? != 0,
                    row.get::<_, Option<String>>(14)?,
                ))
            })
            .map_err(failed)?;
        for row in rows {
            let (
                id,
                title,
                description,
                start,
                end,
                all_day,
                tz,
                color_id,
                source_id,
                provider,
                source_title,
                source_color,
                kind,
                managed,
                source_tz,
            ) = row.map_err(failed)?;
            if let Some(providers) = &input.external_providers
                && !providers.contains(&provider)
            {
                continue;
            }
            let source_hex = display_hex(source_color.as_deref());
            let (color, display_color) = event_colors(color_id.as_deref(), source_hex.as_ref());
            items.push(ProjectionItem {
                projection_id: format!("external_event:{id}"),
                source_type: "external_event".to_owned(),
                source_id: id,
                title,
                description_preview: description_preview(description.as_deref()),
                start_at: start,
                end_at: end,
                is_all_day: all_day,
                timezone: tz
                    .or(source_tz)
                    .unwrap_or_else(|| input.local_timezone.clone()),
                visual_type: "external_event".to_owned(),
                editability: if synced && provider_supports_write(&provider) {
                    Editability::ALL
                } else {
                    Editability::NONE
                },
                source: SourceMeta {
                    provider: Some(provider),
                    calendar_source_id: Some(source_id),
                    title: source_title,
                    color: source_hex,
                    kind: Some(kind),
                    is_memry_managed: managed,
                },
                binding: None,
                snooze_offset_minutes: None,
                color,
                display_color,
                note_id: None,
                anchor_id: None,
                is_triggered: None,
            });
        }
    }
    Ok(items)
}

/// `(id, title, properties, created_at, file_type)`.
type NoteRow = (String, String, Option<String>, Option<i64>, String);
/// `(id, title, content, snoozed_until ms, snoozedUntil verbatim)`.
type SnoozeRow = (String, String, Option<String>, i64, Option<String>);

fn note_rows(conn: &Connection) -> Result<Vec<NoteRow>, StorageError> {
    let mut stmt = conn
        .prepare("SELECT id, title, properties, created_at, file_type FROM notes WHERE deleted_at IS NULL")
        .map_err(failed)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(rows)
}

pub(crate) fn note_items(
    conn: &Connection,
    zone: &dyn LocalZone,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    if input.enabled_property_names.is_empty() && !input.show_notes_by_created {
        return Ok(Vec::new());
    }
    let start_ms = instants::to_epoch_ms(&input.start_at);
    let end_ms = instants::to_epoch_ms(&input.end_at);
    let rows = note_rows(conn)?;
    let mut property_items = Vec::new();
    for (id, title, properties, _, _) in &rows {
        let Some(props) = properties
            .as_deref()
            .and_then(|p| serde_json::from_str::<Value>(p).ok())
        else {
            continue;
        };
        for name in &input.enabled_property_names {
            let Some(value) = props.get(name).and_then(Value::as_str) else {
                continue;
            };
            // `gte(value, start) AND lt(value, end)`, as strings.
            if value < input.start_at.as_str() || value >= input.end_at.as_str() {
                continue;
            }
            let Some(date) = local_day_of(zone, value) else {
                continue;
            };
            property_items.push(ProjectionItem {
                projection_id: format!("note:{id}:{name}"),
                source_type: "note".to_owned(),
                source_id: id.clone(),
                title: title.clone(),
                description_preview: Some(name.clone()),
                start_at: local_instant(zone, date, None),
                end_at: Some(local_all_day_end(zone, date)),
                is_all_day: true,
                timezone: input.local_timezone.clone(),
                visual_type: "note".to_owned(),
                editability: Editability::NONE,
                source: native_source("memrynote Notes"),
                binding: None,
                snooze_offset_minutes: None,
                color: None,
                display_color: None,
                note_id: None,
                anchor_id: None,
                is_triggered: None,
            });
        }
    }
    let mut out = property_items.clone();
    if input.show_notes_by_created {
        let taken: HashSet<String> = property_items
            .iter()
            .map(|item| format!("{}:{}", item.source_id, item.start_at))
            .collect();
        for (id, title, _, created, file_type) in rows {
            let (Some(created), Some(start), Some(end)) = (created, start_ms, end_ms) else {
                continue;
            };
            if file_type != "markdown" || created < start || created >= end {
                continue;
            }
            let date = local_date(zone, created);
            let start_at = local_instant(zone, date, None);
            if taken.contains(&format!("{id}:{start_at}")) {
                continue;
            }
            out.push(ProjectionItem {
                projection_id: format!("note-created:{id}"),
                source_type: "note".to_owned(),
                source_id: id,
                title,
                description_preview: None,
                start_at,
                end_at: Some(local_all_day_end(zone, date)),
                is_all_day: true,
                timezone: input.local_timezone.clone(),
                visual_type: "note".to_owned(),
                editability: Editability::NONE,
                source: native_source("memrynote Notes"),
                binding: None,
                snooze_offset_minutes: None,
                color: None,
                display_color: None,
                note_id: None,
                anchor_id: None,
                is_triggered: None,
            });
        }
    }
    Ok(out)
}
