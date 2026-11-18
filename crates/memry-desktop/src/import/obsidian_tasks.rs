//! `buildObsidianTaskImport` of `packages/shared/src/obsidian-task-import.ts`: the values a line
//! written by the Obsidian Tasks plugin gives the task create call. Core's port of
//! `obsidian-tasks.ts` (`memry_core::markdown::shared::obsidian_tasks`) reads the line; the
//! checklist step decides which lines get here, leaves a line `obsidian_task_import_blocker`
//! names byte-identical, and rewrites a converted one to its title and `{task:<id>}`.
//!
//! The rewrite drops the plugin's fields from the line, so every import keeps the whole original
//! line in `description`. An impossible done date (`2026-02-30`) leaves `completed_at` empty, as
//! in Electron: the task is still created, and the line stays in its description.
//!
//! Vectors: `packages/contracts/test-vectors/importers/obsidian-tasks.json`.

use chrono::{DateTime, Datelike, MappedLocalTime, NaiveDate, Offset, TimeDelta, TimeZone, Utc};
use memry_core::markdown::shared::obsidian_tasks::{
    Frequency, ObsidianPriority, has_obsidian_task_fields, parse_obsidian_task_fields,
};
use serde::{Serialize, Serializer};

/// `ObsidianRepeatConfig`: the slice of a task's repeat config an Obsidian recurrence fills.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianRepeatConfig {
    #[serde(serialize_with = "frequency_name")]
    pub frequency: Frequency,
    /// A JS number: `every 99…9 days` past `f64::MAX` is infinite, which JSON writes as `null`.
    #[serde(serialize_with = "js_number")]
    pub interval: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days_of_week: Option<Vec<u8>>,
    /// Always `never`.
    pub end_type: &'static str,
    /// Always 0.
    pub completed_count: u32,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RepeatFrom {
    Due,
    Completion,
}

/// `ObsidianTaskImport`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianTaskImport {
    /// The description with every recognised plugin field stripped. Tags stay inline.
    pub title: String,
    /// 1 to 4; the plugin's `lowest` collapses onto `low`.
    pub priority: Option<u8>,
    pub due_date: Option<String>,
    /// The start date, else the scheduled date.
    pub start_date: Option<String>,
    /// Without their `#`, casing kept.
    pub tags: Vec<String>,
    pub repeat_config: Option<ObsidianRepeatConfig>,
    pub repeat_from: Option<RepeatFrom>,
    /// The original line, verbatim, so the rewrite stays reversible by hand.
    pub description: String,
    /// The instant local midnight starts on the done date, as JS `toISOString` writes it.
    pub completed_at: Option<String>,
}

fn frequency_name<S: Serializer>(frequency: &Frequency, out: S) -> Result<S::Ok, S::Error> {
    out.serialize_str(frequency.as_str())
}

/// The number `JSON.stringify` writes, as `JSON.parse` reads it back.
fn js_number<S: Serializer>(value: &f64, out: S) -> Result<S::Ok, S::Error> {
    if !value.is_finite() {
        return out.serialize_none();
    }
    if value.fract() == 0.0 && *value >= 0.0 && *value < u64::MAX as f64 {
        // Exact: an integral f64 below 2^64 converts without rounding.
        return out.serialize_u64(*value as u64);
    }
    out.serialize_f64(*value)
}

fn priority(priority: ObsidianPriority) -> u8 {
    match priority {
        ObsidianPriority::Highest => 4,
        ObsidianPriority::High => 3,
        ObsidianPriority::Medium => 2,
        ObsidianPriority::Low | ObsidianPriority::Lowest => 1,
    }
}

/// `Date.prototype.toISOString` for the years a written date reaches (0099 to 9999).
fn js_iso(instant: DateTime<Utc>) -> String {
    format!(
        "{:04}-{}",
        instant.year(),
        instant.format("%m-%dT%H:%M:%S%.3fZ")
    )
}

/// `localMidnight`: the instant local midnight starts on `date` (`YYYY-MM-DD`), or `None` for a
/// date the calendar does not have. JS `new Date(year, month - 1, day)` reads a year below 100
/// as 19xx, so its round-trip check refuses those too.
fn local_midnight<Tz: TimeZone>(date: &str, tz: &Tz) -> Option<String> {
    let mut parts = date.split('-').map(|part| part.parse::<u32>().ok());
    let (year, month, day) = (parts.next()??, parts.next()??, parts.next()??);
    if year < 100 {
        return None;
    }
    let midnight =
        NaiveDate::from_ymd_opt(i32::try_from(year).ok()?, month, day)?.and_hms_opt(0, 0, 0)?;
    let instant = match tz.from_local_datetime(&midnight) {
        MappedLocalTime::Single(at) => at.with_timezone(&Utc),
        // JS takes the earlier of two instants a repeated wall time names.
        MappedLocalTime::Ambiguous(earlier, _) => earlier.with_timezone(&Utc),
        // In a gap JS reads the wall time with the offset in force before it, which lands
        // after the gap: Santiago's 2024-09-08 00:00 is 04:00Z, the -04:00 reading.
        MappedLocalTime::None => {
            let before = tz
                .offset_from_utc_datetime(&(midnight - TimeDelta::days(1)))
                .fix();
            let utc = midnight - TimeDelta::seconds(i64::from(before.local_minus_utc()));
            Utc.from_utc_datetime(&utc)
        }
    };
    Some(js_iso(instant))
}

/// `buildObsidianTaskImport`, with local time read in `tz` (`chrono::Local` in the app). `None`
/// when the text carries nothing this module would change: no plugin syntax, or only an id, a
/// dependency, a block link or tags.
pub fn build_obsidian_task_import<Tz: TimeZone>(
    text: &str,
    now: DateTime<Utc>,
    tz: &Tz,
) -> Option<ObsidianTaskImport> {
    if !has_obsidian_task_fields(text) {
        return None;
    }
    let fields = parse_obsidian_task_fields(text);
    let carries_value = fields.priority.is_some()
        || fields.due_date.is_some()
        || fields.scheduled_date.is_some()
        || fields.start_date.is_some()
        || fields.created_date.is_some()
        || fields.done_date.is_some()
        || fields.cancelled_date.is_some()
        || fields.recurrence_text.is_some()
        || fields.on_completion.is_some();
    if !carries_value {
        return None;
    }

    let repeat_from = fields.recurrence.as_ref().map(|recurrence| {
        if recurrence.from_completion {
            RepeatFrom::Completion
        } else {
            RepeatFrom::Due
        }
    });
    let repeat_config = fields.recurrence.map(|recurrence| ObsidianRepeatConfig {
        frequency: recurrence.frequency,
        interval: recurrence.interval,
        days_of_week: recurrence.days_of_week,
        end_type: "never",
        completed_count: 0,
        created_at: js_iso(now),
    });
    Some(ObsidianTaskImport {
        title: fields.description,
        priority: fields.priority.map(priority),
        due_date: fields.due_date,
        start_date: fields.start_date.or(fields.scheduled_date),
        tags: fields
            .tags
            .iter()
            .map(|tag| tag.strip_prefix('#').unwrap_or(tag).to_owned())
            .collect(),
        repeat_config,
        repeat_from,
        description: text.to_owned(),
        completed_at: fields
            .done_date
            .as_deref()
            .and_then(|date| local_midnight(date, tz)),
    })
}
