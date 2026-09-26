//! Writing Memry items to Google and CalDAV from the phone (spec 007 CL070,
//! CL075). The parts two devices must agree on live here, restated from
//! desktop's provider runtime:
//!
//! - [`route`]: `provider/write-routing.ts` — exactly one provider writes
//!   each item;
//! - [`upsert_input`]: `google/mappers.ts` `map*ToGoogleInput` via
//!   `loadSourceAsGoogleEvent` — the provider-neutral event a push sends;
//! - [`queue`]: which items this device changed and still has to push (fed by
//!   the outbox, so only local changes count, as desktop's
//!   `scheduleGoogleCalendarSourceSync` fires only for them).
//!
//! The shell does the HTTP; the core hands it the body and records the
//! answer ([`bindings`]).

pub mod bindings;
pub mod caldav;
pub mod google;
pub mod ical_write;

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::zone::{LocalZone, local_date, local_to_utc};
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar::CivilDate;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

pub const GOOGLE: &str = "google";
pub const CALDAV: &str = "caldav";

/// `CalendarSyncTarget`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Target {
    /// `event` | `task` | `reminder` | `inbox_snooze`.
    pub source_type: String,
    pub source_id: String,
}

/// `WriteRoute`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Route {
    pub provider: String,
    pub remote_calendar_id: Option<String>,
    pub binding_id: Option<String>,
    /// `binding` | `event_target` | `default_target` | `legacy_google`.
    pub reason: String,
}

/// `findLiveBinding`: the oldest live binding of the item (by `createdAt`,
/// then id), whatever its provider.
pub fn live_binding(
    conn: &Connection,
    target: &Target,
) -> Result<Option<(String, String, String)>, StorageError> {
    conn.query_row(
        "SELECT id, provider, remote_calendar_id FROM calendar_bindings
          WHERE source_type = ?1 AND source_id = ?2 AND archived_at IS NULL AND deleted_at IS NULL
          ORDER BY created_at_raw, id LIMIT 1",
        params![target.source_type, target.source_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    )
    .optional()
    .map_err(failed)
}

/// `findCalendarByRemoteId`: Google wins a collision.
fn calendar_provider_for(
    conn: &Connection,
    remote_calendar_id: &str,
) -> Result<Option<String>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT provider FROM calendar_sources WHERE kind = 'calendar' AND remote_id = ?1
               AND archived_at IS NULL AND deleted_at IS NULL",
        )
        .map_err(failed)?;
    let providers: Vec<String> = stmt
        .query_map([remote_calendar_id], |row| row.get(0))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?;
    Ok(providers
        .iter()
        .find(|p| *p == GOOGLE)
        .or(providers.first())
        .cloned())
}

/// `readDefaultWriteTarget`: the cross-provider target while it is live (a
/// non-Google one only while its calendar is connected and shown), else
/// Google's own default.
pub fn default_target(conn: &Connection) -> Result<Option<(String, String)>, StorageError> {
    if let Some(stored) = crate::domain::settings::read(conn, "calendar.defaultWriteTarget")? {
        if stored.is_null() {
            return Ok(None);
        }
        if let (Some(provider), Some(remote)) = (
            stored.get("provider").and_then(Value::as_str),
            stored.get("remoteCalendarId").and_then(Value::as_str),
        ) && !provider.is_empty()
            && !remote.is_empty()
        {
            let live = provider == GOOGLE
                || conn
                    .query_row(
                        "SELECT 1 FROM calendar_sources WHERE kind = 'calendar' AND remote_id = ?1
                           AND provider = ?2 AND is_selected = 1 AND archived_at IS NULL
                           AND deleted_at IS NULL",
                        params![remote, provider],
                        |_| Ok(()),
                    )
                    .optional()
                    .map_err(failed)?
                    .is_some();
            if live {
                return Ok(Some((provider.to_owned(), remote.to_owned())));
            }
        }
    }
    let google = crate::domain::settings::read(conn, "calendar.google.defaultTargetCalendarId")?;
    Ok(google
        .as_ref()
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(|id| (GOOGLE.to_owned(), id.to_owned())))
}

/// `resolveWriteRoute`.
pub fn route(conn: &Connection, target: &Target) -> Result<Route, StorageError> {
    if let Some((id, provider, calendar)) = live_binding(conn, target)? {
        return Ok(Route {
            provider,
            remote_calendar_id: Some(calendar),
            binding_id: Some(id),
            reason: "binding".to_owned(),
        });
    }
    if target.source_type == "event" {
        let event_target: Option<String> = conn
            .query_row(
                "SELECT target_calendar_id FROM calendar_events WHERE id = ?1",
                [&target.source_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?
            .flatten();
        if let Some(remote) = event_target.filter(|t| !t.is_empty()) {
            // An id no source knows is what older builds always sent Google.
            let provider =
                calendar_provider_for(conn, &remote)?.unwrap_or_else(|| GOOGLE.to_owned());
            return Ok(Route {
                provider,
                remote_calendar_id: Some(remote),
                binding_id: None,
                reason: "event_target".to_owned(),
            });
        }
    }
    if let Some((provider, remote)) = default_target(conn)? {
        return Ok(Route {
            provider,
            remote_calendar_id: Some(remote),
            binding_id: None,
            reason: "default_target".to_owned(),
        });
    }
    Ok(Route {
        provider: GOOGLE.to_owned(),
        remote_calendar_id: None,
        binding_id: None,
        reason: "legacy_google".to_owned(),
    })
}

fn iso(ms: i64) -> String {
    instants::to_iso8601(ms).unwrap_or_default()
}

/// `toLocalDateTime(dateStr, timeStr)`.
fn local_date_time(zone: &dyn LocalZone, date: &str, time: Option<&str>) -> Option<String> {
    let day = CivilDate::parse_key(date)?;
    let (hour, minute) = time
        .and_then(|t| t.split_once(':'))
        .and_then(|(h, m)| Some((h.parse().ok()?, m.get(..2).unwrap_or(m).parse().ok()?)))
        .unwrap_or((0, 0));
    Some(iso(local_to_utc(zone, day, hour, minute)))
}

fn text(value: Option<String>) -> Value {
    value.map_or(Value::Null, Value::String)
}

fn json_column(value: Option<String>) -> Value {
    value
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null)
}

/// `buildExdateLine` + `toGoogleRecurrenceWithExceptions`: the event's RRULE
/// and its exceptions as Google `recurrence` lines.
/// `toGoogleRecurrenceWithExceptions`: RRULE plus one EXDATE per exception,
/// in the event's zone (`isoToZonedIcalStamp`). The event's zone comes from
/// `named`, or is the device's; a zone the shell did not resolve writes a UTC
/// EXDATE, which names the same instant.
pub fn recurrence_lines(
    rule: &Value,
    exceptions: &Value,
    timezone: &str,
    device: (&dyn LocalZone, &str),
    named: &HashMap<String, CalendarZone>,
) -> Value {
    let zone: Option<&dyn LocalZone> = if timezone == device.1 {
        Some(device.0)
    } else {
        named.get(timezone).map(|z| z as &dyn LocalZone)
    };
    let mut lines: Vec<String> = Vec::new();
    if let Some(rrule) = rule.get("rrule").and_then(Value::as_str) {
        lines.push(format!("RRULE:{rrule}"));
    }
    for exception in exceptions
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let Some(ms) = instants::to_epoch_ms(exception) else {
            continue;
        };
        let zone = zone.filter(|_| timezone != "UTC");
        if let Some(zone) = zone {
            let local = ms + zone.offset_ms(ms);
            let day = CivilDate::from_days_since_epoch(local.div_euclid(86_400_000));
            let rest = local.rem_euclid(86_400_000) / 1000;
            lines.push(format!(
                "EXDATE;TZID={timezone}:{}T{:02}{:02}{:02}",
                day.key().replace('-', ""),
                rest / 3600,
                rest / 60 % 60,
                rest % 60
            ));
        } else {
            let stamp = iso(ms).replace(".000", "").replace(['-', ':'], "");
            lines.push(format!("EXDATE:{stamp}"));
        }
    }
    if lines.is_empty() {
        Value::Null
    } else {
        json!(lines)
    }
}

/// `shouldSourceBeOnCalendar` + `loadSourceAsGoogleEvent`: the item as the
/// provider-neutral event a push sends (`GoogleCalendarUpsertEventInput`), or
/// `None` when it should not be on a calendar (archived, done, unscheduled,
/// dismissed, filed). `zone` is the device's; `zone_id` its IANA name;
/// `named` the other zones the shell resolved.
pub fn upsert_input(
    conn: &Connection,
    target: &Target,
    zone: &dyn LocalZone,
    zone_id: &str,
    named: &HashMap<String, CalendarZone>,
) -> Result<Option<Value>, StorageError> {
    let base = |title: String,
                description: Option<String>,
                start: String,
                end: Option<String>,
                all_day: bool| {
        json!({
            "sourceType": target.source_type,
            "sourceId": target.source_id,
            "title": title,
            "description": description,
            "location": null,
            "startAt": start,
            "endAt": end,
            "isAllDay": all_day,
            "timezone": zone_id,
            "recurrence": null,
        })
    };
    let id = &target.source_id;
    let found = match target.source_type.as_str() {
        "event" => conn
            .query_row(
                "SELECT title, description, location, start_at, end_at, is_all_day, timezone,
                        recurrence_rule, recurrence_exceptions, attendees, reminders, visibility,
                        color_id, conference_data, parent_event_id, original_start_time
                   FROM calendar_events WHERE id = ?1 AND archived_at IS NULL AND deleted_at IS NULL",
                [id],
                |row| {
                    let timezone: String = row.get(6)?;
                    let rule = json_column(row.get(7)?);
                    let exceptions = json_column(row.get(8)?);
                    Ok(json!({
                        "sourceType": "event",
                        "sourceId": id,
                        "title": row.get::<_, String>(0)?,
                        "description": text(row.get(1)?),
                        "location": text(row.get(2)?),
                        "startAt": row.get::<_, String>(3)?,
                        "endAt": text(row.get(4)?),
                        "isAllDay": row.get::<_, bool>(5)?,
                        "timezone": timezone,
                        "recurrence": recurrence_lines(&rule, &exceptions, &timezone, (zone, zone_id), named),
                        "attendees": json_column(row.get(9)?),
                        "reminders": json_column(row.get(10)?),
                        "visibility": text(row.get(11)?),
                        "colorId": text(row.get(12)?),
                        "conferenceData": json_column(row.get(13)?),
                        "recurringEventId": text(row.get(14)?),
                        "originalStartTime": text(row.get(15)?),
                    }))
                },
            )
            .optional()
            .map_err(failed)?,
        "task" => conn
            .query_row(
                "SELECT title, description, due_date, due_time FROM tasks
                  WHERE id = ?1 AND archived_at IS NULL AND completed_at IS NULL AND deleted_at IS NULL
                    AND due_date IS NOT NULL",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
            )
            .optional()
            .map_err(failed)?
            .and_then(|(title, description, date, time)| {
                let all_day = time.is_none();
                let start = local_date_time(zone, &date, time.as_deref())?;
                let end = if all_day {
                    CivilDate::parse_key(&date).map(|d| iso(local_to_utc(zone, d.add_days(1), 0, 0)))
                } else {
                    None
                };
                Some(base(title, description, start, end, all_day))
            }),
        "reminder" => conn
            .query_row(
                "SELECT title, note, highlight_text, remind_at, status, snoozed_until FROM reminders
                  WHERE id = ?1 AND deleted_at IS NULL",
                [id],
                |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, Option<String>>(1)?,
                        row.get::<_, Option<String>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()
            .map_err(failed)?
            .and_then(|(title, note, highlight, remind_at, status, snoozed)| {
                let start = match status.as_str() {
                    "dismissed" | "triggered" => return None,
                    "snoozed" => snoozed?,
                    _ => remind_at,
                };
                let title = title.map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()).unwrap_or_else(|| "Reminder".to_owned());
                Some(base(title, note.or(highlight), start, None, false))
            }),
        "inbox_snooze" => conn
            .query_row(
                "SELECT title, content, snoozed_until FROM inbox_items
                  WHERE id = ?1 AND archived_at IS NULL AND filed_at IS NULL AND deleted_at IS NULL
                    AND snoozed_until IS NOT NULL",
                [id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, i64>(2)?)),
            )
            .optional()
            .map_err(failed)?
            .map(|(title, content, until)| base(title, content, iso(until), None, false)),
        _ => None,
    };
    Ok(found)
}

/// The local day key an instant falls on (all-day pushes send days).
pub fn local_day(zone: &dyn LocalZone, iso_text: &str) -> Option<String> {
    instants::to_epoch_ms(iso_text).map(|ms| local_date(zone, ms).key())
}

/// One queued push.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub target: Target,
    pub attempts: i64,
}

/// The items this device changed and still has to write out.
pub fn queue(conn: &Connection) -> Result<Vec<Queued>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT source_type, source_id, attempts FROM calendar_push_queue ORDER BY queued_at",
        )
        .map_err(failed)?;
    stmt.query_map([], |row| {
        Ok(Queued {
            target: Target {
                source_type: row.get(0)?,
                source_id: row.get(1)?,
            },
            attempts: row.get(2)?,
        })
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

/// Done (written, or nothing to write): off the queue.
pub fn dequeue(conn: &Connection, target: &Target) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM calendar_push_queue WHERE source_type = ?1 AND source_id = ?2",
        params![target.source_type, target.source_id],
    )
    .map_err(failed)?;
    Ok(())
}

/// A failed attempt stays queued with its reason.
pub fn mark_failed(conn: &Connection, target: &Target, error: &str) -> Result<(), StorageError> {
    conn.execute(
        "UPDATE calendar_push_queue SET attempts = attempts + 1, last_error = ?3
          WHERE source_type = ?1 AND source_id = ?2",
        params![target.source_type, target.source_id, error],
    )
    .map_err(failed)?;
    Ok(())
}

/// `applyProviderDelete`: the remote event of a bound item is gone. The
/// Memry event is deleted, a task unscheduled; the binding retires. Bound
/// reminders and inbox snoozes are left to desktop (§6 CL074).
pub fn apply_remote_delete(
    conn: &Connection,
    target: &Target,
    binding_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    match target.source_type.as_str() {
        "event" => {
            if crate::domain::calendar_items::write::live_payload(
                conn,
                crate::domain::calendar_items::EVENT_TYPE,
                &target.source_id,
            )?
            .is_some()
            {
                crate::domain::calendar_items::write::delete_event(
                    conn,
                    &target.source_id,
                    device_id,
                    now_ms,
                )?;
            }
        }
        "task" => {
            crate::domain::tasks::set_due(conn, &target.source_id, None, None, device_id, now_ms)?
                .acknowledge();
        }
        _ => {}
    }
    bindings::record_delete(conn, binding_id, device_id, now_ms)?;
    dequeue(conn, target)
}
