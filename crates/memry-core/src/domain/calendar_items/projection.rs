//! The range projection: `getCalendarRangeProjection`
//! (`apps/desktop/src/main/calendar/projection.ts`), loader for loader
//! (spec 007 §5 F2).
//!
//! Every comparison desktop makes on a stored ISO string is made here on the
//! same string (`start_at < end`), and the result is sorted by `startAt` then
//! `projectionId` as strings. Local-day arithmetic goes through [`LocalZone`].

use std::collections::HashMap;

use rusqlite::{Connection, params_from_iter};

use crate::api::errors::StorageError;
use crate::domain::calendar::CivilDate;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

use super::colors::{calendar_color_hex, display_hex, event_color_from_id};
use super::locale_compare;
use super::projection_sources::{
    external_events, inbox_snoozes, note_date_reminders, note_items, reminders,
};
use super::zone::{LocalZone, local_date, local_to_utc};

pub use super::projection_sources::provider_supports_write;

/// What a projection item allows (`CalendarProjectionEditability`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Editability {
    pub can_move: bool,
    pub can_resize: bool,
    pub can_edit_text: bool,
    pub can_delete: bool,
}

impl Editability {
    pub const ALL: Self = Self {
        can_move: true,
        can_resize: true,
        can_edit_text: true,
        can_delete: true,
    };
    pub const NONE: Self = Self {
        can_move: false,
        can_resize: false,
        can_edit_text: false,
        can_delete: false,
    };
    pub(crate) const MOVE_TEXT_DELETE: Self = Self {
        can_move: true,
        can_resize: false,
        can_edit_text: true,
        can_delete: true,
    };
}

/// `CalendarProjectionSourceMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceMeta {
    pub provider: Option<String>,
    pub calendar_source_id: Option<String>,
    pub title: String,
    pub color: Option<String>,
    pub kind: Option<String>,
    pub is_memry_managed: bool,
}

/// `CalendarProjectionBinding`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingMeta {
    pub provider: String,
    pub remote_calendar_id: String,
    pub remote_event_id: String,
    pub ownership_mode: String,
    pub writeback_mode: String,
}

/// `CalendarProjectionItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionItem {
    pub projection_id: String,
    pub source_type: String,
    pub source_id: String,
    pub title: String,
    pub description_preview: Option<String>,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    pub timezone: String,
    pub visual_type: String,
    pub editability: Editability,
    pub source: SourceMeta,
    pub binding: Option<BindingMeta>,
    pub snooze_offset_minutes: Option<i64>,
    /// The event colour name (`CalendarEventColor`), events only.
    pub color: Option<String>,
    pub display_color: Option<String>,
    pub note_id: Option<String>,
    pub anchor_id: Option<String>,
    pub is_triggered: Option<bool>,
    /// Task items only: what the calendar's status picker needs (`item.task`).
    pub task: Option<TaskMeta>,
}

/// `CalendarProjectionItem.task`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskMeta {
    pub project_id: String,
    pub status_id: Option<String>,
    pub is_completed: bool,
}

/// `GetCalendarRangeInput`, plus desktop's two side inputs.
#[derive(Debug, Clone)]
pub struct RangeInput {
    pub start_at: String,
    pub end_at: String,
    pub include_unselected_sources: bool,
    /// `includeCompletedTasks`: completed tasks stay in the range, flagged
    /// `task.isCompleted` (the calendar page draws them faded).
    pub include_completed_tasks: bool,
    /// `includeExternal: false` drops imported events entirely.
    pub include_external: bool,
    /// `externalProviders`: `None` = every provider.
    pub external_providers: Option<Vec<String>>,
    /// `getCalendarEnabledPropertyNames()`.
    pub enabled_property_names: Vec<String>,
    /// `getCalendarSettings().showNotesOnCalendar`.
    pub show_notes_by_created: bool,
    /// `Intl.DateTimeFormat().resolvedOptions().timeZone`.
    pub local_timezone: String,
}

/// `getDescriptionPreview`: 280 UTF-16 units, else 277 and `...`.
pub fn description_preview(value: Option<&str>) -> Option<String> {
    let value = value.filter(|v| !v.is_empty())?;
    let units: Vec<u16> = value.encode_utf16().collect();
    if units.len() <= 280 {
        return Some(value.to_owned());
    }
    Some(format!("{}...", String::from_utf16_lossy(&units[..277])))
}

pub(crate) fn native_source(title: &str) -> SourceMeta {
    SourceMeta {
        provider: None,
        calendar_source_id: None,
        title: title.to_owned(),
        color: None,
        kind: None,
        is_memry_managed: true,
    }
}

pub(crate) fn iso(ms: i64) -> String {
    instants::to_iso8601(ms).unwrap_or_default()
}

/// `toLocalInstant(dateStr, timeStr)`.
pub(crate) fn local_instant(zone: &dyn LocalZone, date: CivilDate, time: Option<&str>) -> String {
    let (hour, minute) = time
        .and_then(|t| {
            let (h, m) = t.split_once(':')?;
            Some((
                h.trim().parse::<u32>().ok()?,
                m.get(..2).unwrap_or(m).parse::<u32>().ok()?,
            ))
        })
        .unwrap_or((0, 0));
    iso(local_to_utc(zone, date, hour, minute))
}

/// `toLocalAllDayEnd(dateStr)`: the next local midnight.
pub(crate) fn local_all_day_end(zone: &dyn LocalZone, date: CivilDate) -> String {
    iso(local_to_utc(zone, date.add_days(1), 0, 0))
}

/// `getLocalDueDateRange`: `None` for an empty or inverted range.
fn local_due_range(zone: &dyn LocalZone, input: &RangeInput) -> Option<(String, String)> {
    let start = instants::to_epoch_ms(&input.start_at)?;
    let end = instants::to_epoch_ms(&input.end_at)?;
    if end <= start {
        return None;
    }
    Some((
        local_date(zone, start).key(),
        local_date(zone, end - 1).key(),
    ))
}

/// `localDayOfDateValue`: a bare date as is, an instant by its local day.
pub(crate) fn local_day_of(zone: &dyn LocalZone, value: &str) -> Option<CivilDate> {
    if value.len() == 10
        && let Some(date) = CivilDate::parse_key(value)
    {
        return Some(date);
    }
    Some(local_date(zone, instants::to_epoch_ms(value)?))
}

pub(crate) fn bindings_by_source(
    conn: &Connection,
    source_type: &str,
    ids: &[String],
) -> Result<HashMap<String, BindingMeta>, StorageError> {
    let mut out = HashMap::new();
    if ids.is_empty() {
        return Ok(out);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let sql = format!(
        "SELECT source_id, provider, remote_calendar_id, remote_event_id, ownership_mode,
                writeback_mode
           FROM calendar_bindings
          WHERE deleted_at IS NULL AND archived_at IS NULL AND source_type = ?
            AND source_id IN ({placeholders})
          ORDER BY created_at_raw, id"
    );
    let mut values: Vec<String> = vec![source_type.to_owned()];
    values.extend(ids.iter().cloned());
    let mut stmt = conn.prepare(&sql).map_err(failed)?;
    let rows = stmt
        .query_map(params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, String>(0)?,
                BindingMeta {
                    provider: row.get(1)?,
                    remote_calendar_id: row.get(2)?,
                    remote_event_id: row.get(3)?,
                    ownership_mode: row.get(4)?,
                    writeback_mode: row.get(5)?,
                },
            ))
        })
        .map_err(failed)?;
    // Desktop's `new Map(rows)` keeps the last row per source, in SQLite's
    // insert order. The phone's insert order is arrival order, so it orders by
    // `createdAt` instead: the newest binding lands last and wins.
    for row in rows {
        let (id, binding) = row.map_err(failed)?;
        out.insert(id, binding);
    }
    Ok(out)
}

/// `loadGoogleCalendarColors`: display hex per Google calendar remote id.
fn google_calendar_colors(conn: &Connection) -> Result<HashMap<String, String>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT remote_id, color FROM calendar_sources
              WHERE deleted_at IS NULL AND provider = 'google' AND kind = 'calendar'
                AND archived_at IS NULL",
        )
        .map_err(failed)?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(failed)?;
    let mut out = HashMap::new();
    for row in rows {
        let (remote, color) = row.map_err(failed)?;
        if let Some(hex) = display_hex(color.as_deref()) {
            out.insert(remote, hex);
        }
    }
    Ok(out)
}

/// `eventColors(colorId, calendarHex)`.
pub(crate) fn event_colors(
    color_id: Option<&str>,
    calendar_hex: Option<&String>,
) -> (Option<String>, Option<String>) {
    match event_color_from_id(color_id) {
        Some(name) => (
            Some(name.to_owned()),
            calendar_color_hex(name).map(str::to_owned),
        ),
        None => (None, calendar_hex.cloned()),
    }
}

fn memry_events(
    conn: &Connection,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, description, start_at, end_at, is_all_day, timezone, color_id,
                    target_calendar_id
               FROM calendar_events
              WHERE deleted_at IS NULL AND archived_at IS NULL
                AND start_at < ?1 AND coalesce(end_at, start_at) >= ?2
              ORDER BY start_at",
        )
        .map_err(failed)?;
    type Row = (
        String,
        String,
        Option<String>,
        String,
        Option<String>,
        bool,
        String,
        Option<String>,
        Option<String>,
    );
    let rows: Vec<Row> = stmt
        .query_map([&input.end_at, &input.start_at], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get::<_, i64>(5)? != 0,
                row.get(6)?,
                row.get(7)?,
                row.get(8)?,
            ))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let ids: Vec<String> = rows.iter().map(|r| r.0.clone()).collect();
    let bindings = bindings_by_source(conn, "event", &ids)?;
    let colors = if rows.is_empty() {
        HashMap::new()
    } else {
        google_calendar_colors(conn)?
    };
    Ok(rows
        .into_iter()
        .map(
            |(id, title, description, start, end, all_day, tz, color_id, target)| {
                let binding = bindings.get(&id).cloned();
                let calendar_key = binding
                    .as_ref()
                    .map(|b| b.remote_calendar_id.clone())
                    .or(target)
                    .unwrap_or_default();
                let (color, display_color) =
                    event_colors(color_id.as_deref(), colors.get(&calendar_key));
                ProjectionItem {
                    projection_id: format!("event:{id}"),
                    source_type: "event".to_owned(),
                    source_id: id,
                    title,
                    description_preview: description_preview(description.as_deref()),
                    start_at: start,
                    end_at: end,
                    is_all_day: all_day,
                    timezone: tz,
                    visual_type: "event".to_owned(),
                    editability: Editability::ALL,
                    source: native_source("memrynote"),
                    binding,
                    snooze_offset_minutes: None,
                    color,
                    display_color,
                    note_id: None,
                    anchor_id: None,
                    is_triggered: None,
                    task: None,
                }
            },
        )
        .collect())
}

/// One dated task row (`loadTaskItems`).
struct TaskRow {
    id: String,
    title: String,
    description: Option<String>,
    due_date: String,
    due_time: Option<String>,
    project_id: String,
    status_id: Option<String>,
    is_completed: bool,
    /// `durationMinutes`, which has no column: read from the record's payload.
    duration_minutes: Option<f64>,
}

/// `taskEditability(canResize)`: a task with a duration is a block that resizes.
const fn task_editability(can_resize: bool) -> Editability {
    Editability {
        can_resize,
        ..Editability::MOVE_TEXT_DELETE
    }
}

fn tasks(
    conn: &Connection,
    zone: &dyn LocalZone,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let Some((start_date, end_date)) = local_due_range(zone, input) else {
        return Ok(Vec::new());
    };
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.title, t.description, t.due_date, t.due_time, t.project_id,
                    t.status_id, t.completed_at IS NOT NULL,
                    json_extract(s.payload, '$.durationMinutes')
               FROM tasks t
               LEFT JOIN sync_items s ON s.item_type = 'task' AND s.item_id = t.id
              WHERE t.deleted_at IS NULL AND t.due_date IS NOT NULL
                AND t.due_date >= ?1 AND t.due_date <= ?2
                AND (?3 OR t.completed_at IS NULL) AND t.archived_at IS NULL
              ORDER BY t.due_date, t.due_time, t.position",
        )
        .map_err(failed)?;
    let rows: Vec<TaskRow> = stmt
        .query_map(
            rusqlite::params![start_date, end_date, input.include_completed_tasks],
            |row| {
                Ok(TaskRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    description: row.get(2)?,
                    due_date: row.get(3)?,
                    due_time: row.get(4)?,
                    project_id: row.get(5)?,
                    status_id: row.get(6)?,
                    is_completed: row.get(7)?,
                    duration_minutes: row.get::<_, Option<f64>>(8).unwrap_or(None),
                })
            },
        )
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    let ids: Vec<String> = rows.iter().map(|r| r.id.clone()).collect();
    let bindings = bindings_by_source(conn, "task", &ids)?;
    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let date = CivilDate::parse_key(row.due_date.get(..10)?)?;
            let due_time = row.due_time.filter(|t| !t.is_empty());
            let is_all_day = due_time.is_none();
            let start_at = local_instant(zone, date, due_time.as_deref());
            let block_minutes = row.duration_minutes.filter(|_| !is_all_day);
            // `blockMinutes ? start + minutes : null`: zero minutes is no block.
            let end_at = if is_all_day {
                Some(local_all_day_end(zone, date))
            } else {
                block_minutes
                    .filter(|minutes| *minutes != 0.0 && minutes.is_finite())
                    .and_then(|minutes| {
                        let start = instants::to_epoch_ms(&start_at)?;
                        #[allow(clippy::cast_possible_truncation)]
                        let span = (minutes * 60_000.0) as i64;
                        Some(iso(start.checked_add(span)?))
                    })
            };
            Some(ProjectionItem {
                projection_id: format!("task:{}", row.id),
                source_type: "task".to_owned(),
                binding: bindings.get(&row.id).cloned(),
                source_id: row.id,
                title: row.title,
                description_preview: description_preview(row.description.as_deref()),
                start_at,
                end_at,
                is_all_day,
                timezone: input.local_timezone.clone(),
                visual_type: "task".to_owned(),
                editability: task_editability(block_minutes.is_some()),
                source: native_source("memrynote Tasks"),
                snooze_offset_minutes: None,
                color: None,
                display_color: None,
                note_id: None,
                anchor_id: None,
                is_triggered: None,
                task: Some(TaskMeta {
                    project_id: row.project_id,
                    status_id: row.status_id,
                    is_completed: row.is_completed,
                }),
            })
        })
        .collect())
}

/// `getCalendarRangeProjection`.
pub fn range(
    conn: &Connection,
    zone: &dyn LocalZone,
    input: &RangeInput,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let mut items = memry_events(conn, input)?;
    items.extend(tasks(conn, zone, input)?);
    items.extend(reminders(conn, input)?);
    items.extend(note_date_reminders(conn, input)?);
    items.extend(inbox_snoozes(conn, input)?);
    let providers_empty = input.external_providers.as_ref().is_some_and(Vec::is_empty);
    if input.include_external && !providers_empty {
        items.extend(external_events(conn, input)?);
    }
    items.extend(note_items(conn, zone, input)?);
    items.sort_by(|a, b| {
        locale_compare(&a.start_at, &b.start_at)
            .then_with(|| locale_compare(&a.projection_id, &b.projection_id))
    });
    Ok(items)
}

/// `filterCalendarItems` (`calendar-search-filter.ts`) over the range
/// `CalendarSearch` loads (unselected sources included): title or preview
/// contains the query, nearest to `now_ms` first, at most `limit`.
pub fn search(
    conn: &Connection,
    zone: &dyn LocalZone,
    input: &RangeInput,
    query: &str,
    now_ms: i64,
    limit: usize,
) -> Result<Vec<ProjectionItem>, StorageError> {
    let needle = query.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits: Vec<ProjectionItem> = range(conn, zone, input)?
        .into_iter()
        .filter(|item| {
            item.title.to_lowercase().contains(&needle)
                || item
                    .description_preview
                    .as_deref()
                    .is_some_and(|d| d.to_lowercase().contains(&needle))
        })
        .collect();
    let distance = |item: &ProjectionItem| {
        instants::to_epoch_ms(&item.start_at).map_or(i64::MAX, |ms| (ms - now_ms).abs())
    };
    hits.sort_by_key(distance);
    hits.truncate(limit);
    Ok(hits)
}
