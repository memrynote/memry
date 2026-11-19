//! A pulled CalDAV object Memry wrote flows back into the items bound to it
//! (`applyBoundCaldavObject`), unless a local change to the item is still
//! queued: the drain sends that change first, and its `If-Match` meets the
//! remote change as a conflict instead of the pull overwriting the edit. That conflict merges
//! the server's copy into the item ([`merge_remote`]) before the drain's one retry.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

use super::caldav::Object;
use super::{CALDAV, Target, bindings};
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::colors::event_color_from_id;
use crate::domain::calendar_items::ical::parse::Component;
use crate::domain::calendar_items::ical::{
    IcalInstance, IcalWindow, IcalZones, expand_calendar_events, parse::parse_calendar,
};
use crate::domain::calendar_items::write::{EventPatch, update_event};
use crate::domain::calendar_items::zone::LocalZone;
use crate::domain::notes::failed;
use crate::storage::repositories::{Change, instants};

const YEAR_MS: i64 = 366 * 24 * 60 * 60 * 1000;

/// What the bound items of one object took.
pub struct Bound {
    /// A binding holds the whole object, so none of it mirrors.
    pub whole: bool,
    /// The remote event ids the bindings hold.
    pub handled: Vec<String>,
    pub changed: usize,
}

pub(super) fn queued(conn: &Connection, target: &Target) -> Result<bool, StorageError> {
    conn.query_row(
        "SELECT 1 FROM calendar_push_queue WHERE source_type = ?1 AND source_id = ?2",
        params![target.source_type, target.source_id],
        |_| Ok(()),
    )
    .optional()
    .map(|row| row.is_some())
    .map_err(failed)
}

#[allow(clippy::too_many_arguments)]
pub fn apply(
    conn: &Connection,
    calendar_url: &str,
    object: &Object,
    root: &Component,
    instances: &[IcalInstance],
    window: IcalWindow,
    zones: &IcalZones,
    device_zone: &dyn LocalZone,
    zone_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<Bound, StorageError> {
    let mut bound = Bound {
        whole: false,
        handled: Vec::new(),
        changed: 0,
    };
    for (target, binding) in bindings::for_object(conn, calendar_url, &object.href)? {
        bound.handled.push(binding.remote_event_id.clone());
        bound.whole |= binding.remote_event_id == object.href;
        // Our own write, read back; or a local change the drain has yet to send.
        if binding.remote_version.is_some() && binding.remote_version == object.etag
            || queued(conn, &target)?
        {
            continue;
        }
        let (_, rid) = bindings::caldav_parts(&binding.remote_event_id);
        let instance = instance_for(&binding, object, root, instances, window, zones);
        match instance {
            Some(instance) => write_back(
                conn,
                &target,
                &binding,
                calendar_url,
                object,
                &instance,
                device_zone,
                zone_id,
                &zones.named,
                device_id,
                now_ms,
            )?,
            // An occurrence the series no longer produces (EXDATE, a cancelled override) inside
            // the window is gone; one outside it is left for a later pull.
            None => {
                let inside = rid
                    .and_then(instants::to_epoch_ms)
                    .is_some_and(|ms| ms >= window.start_ms && ms < window.end_ms);
                if !inside {
                    continue;
                }
                super::apply_remote_delete(conn, &target, &binding.id, device_id, now_ms)?;
            }
        }
        bound.changed += 1;
    }
    Ok(bound)
}

/// The instance a binding takes from an object: its occurrence, else (a whole object) the first
/// in the window. A single event the server moved out of the window still moves its item; a
/// series there is left, as its occurrences are.
fn instance_for(
    binding: &bindings::Binding,
    object: &Object,
    root: &Component,
    instances: &[IcalInstance],
    window: IcalWindow,
    zones: &IcalZones,
) -> Option<IcalInstance> {
    let (_, rid) = bindings::caldav_parts(&binding.remote_event_id);
    let found = instances
        .iter()
        .find(|i| i.remote_event_id == binding.remote_event_id)
        .or_else(|| rid.is_none().then(|| instances.first()).flatten())
        .cloned();
    if found.is_some() || rid.is_some() || object.data.contains("RRULE") {
        return found;
    }
    let href = object.href.clone();
    let key = move |_uid: &str, rid: Option<&str>| {
        rid.map_or_else(|| href.clone(), |rid| format!("{href}::{rid}"))
    };
    let wide = IcalWindow {
        start_ms: window.start_ms - 50 * YEAR_MS,
        end_ms: window.end_ms + 50 * YEAR_MS,
    };
    let calendar_zone = root.text("X-WR-TIMEZONE");
    expand_calendar_events(root, wide, calendar_zone.as_deref(), &key, zones)
        .ok()
        .and_then(|all| all.into_iter().next())
}

/// `object` parsed and expanded as a pull would, then the binding's instance of it.
fn instance_of(
    binding: &bindings::Binding,
    object: &Object,
    window: IcalWindow,
    zones: &IcalZones,
) -> Option<IcalInstance> {
    let root = parse_calendar(&object.data).ok()?;
    let href = object.href.clone();
    let key = move |_uid: &str, rid: Option<&str>| {
        rid.map_or_else(|| href.clone(), |rid| format!("{href}::{rid}"))
    };
    let calendar_zone = root.text("X-WR-TIMEZONE");
    let instances =
        expand_calendar_events(&root, window, calendar_zone.as_deref(), &key, zones).ok()?;
    instance_for(binding, object, &root, &instances, window, zones)
}

/// An update met a 412 and `object` is what the server holds now (`pushEventWithConflictRetry`
/// with `threeWayMerge`, `mergeRemoteEventIntoLocal`). Each field the server changed since the
/// copy the binding stored takes the server's value, even one the local edit changed too (equal
/// field clocks, so `mergeFields` takes the remote); every other field keeps the local edit.
/// Without a stored copy the server wins every field. Only events merge, as in Electron; another
/// item's retry sends it as it is. Answers the item's queue stamp after the merge, which the
/// retry's `push_done` takes.
pub fn merge_remote(
    conn: &Connection,
    target: &Target,
    object: &Object,
    window: IcalWindow,
    zones: &IcalZones,
    device_id: &str,
    now_ms: i64,
) -> Result<Option<i64>, StorageError> {
    if target.source_type == "event"
        && let Some(binding) = bindings::find(conn, CALDAV, target)?
        && let Some(remote) = instance_of(&binding, object, window, zones)
    {
        let stored = bindings::stored_object(conn, &binding)?.map(|data| Object {
            href: object.href.clone(),
            etag: binding.remote_version.clone(),
            data,
        });
        let base = stored.and_then(|s| instance_of(&binding, &s, window, zones));
        let patch = remote_patch(&remote, base.as_ref());
        update_event(conn, &target.source_id, &patch, device_id, now_ms)?;
    }
    conn.query_row(
        "SELECT queued_at FROM calendar_push_queue WHERE source_type = ?1 AND source_id = ?2",
        params![target.source_type, target.source_id],
        |row| row.get(0),
    )
    .optional()
    .map_err(failed)
}

/// `mapGoogleEventToCalendarEventChanges` for one server instance: each field the server changed
/// since `base` (every field without one). RRULE and STATUS are not among them, as in Electron.
fn remote_patch(remote: &IcalInstance, base: Option<&IcalInstance>) -> EventPatch {
    let changed =
        |same: fn(&IcalInstance, &IcalInstance) -> bool| base.is_none_or(|b| !same(b, remote));
    EventPatch {
        title: changed(|b, r| b.title == r.title).then(|| remote.title.clone()),
        description: changed(|b, r| b.description == r.description)
            .then(|| remote.description.clone()),
        location: changed(|b, r| b.location == r.location).then(|| remote.location.clone()),
        start_at: changed(|b, r| b.start_at == r.start_at).then(|| remote.start_at.clone()),
        end_at: changed(|b, r| b.end_at == r.end_at).then(|| remote.end_at.clone()),
        timezone: remote
            .timezone
            .clone()
            .filter(|_| changed(|b, r| b.timezone == r.timezone)),
        is_all_day: changed(|b, r| b.is_all_day == r.is_all_day).then_some(remote.is_all_day),
        attendees: changed(|b, r| b.attendees == r.attendees)
            .then(|| remote.attendees.clone().unwrap_or(Value::Null)),
        reminders: changed(|b, r| b.reminders == r.reminders)
            .then(|| remote.reminders.clone().unwrap_or(Value::Null)),
        visibility: changed(|b, r| b.visibility == r.visibility).then(|| remote.visibility.clone()),
        color: changed(|b, r| b.color_id == r.color_id)
            .then(|| event_color_from_id(remote.color_id.as_deref()).map(str::to_owned)),
        ..EventPatch::default()
    }
}

#[allow(clippy::too_many_arguments)]
fn write_back(
    conn: &Connection,
    target: &Target,
    binding: &bindings::Binding,
    calendar_url: &str,
    object: &Object,
    instance: &IcalInstance,
    zone: &dyn LocalZone,
    zone_id: &str,
    named: &HashMap<String, CalendarZone>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    if target.source_type == "event" {
        update_event(
            conn,
            &target.source_id,
            &remote_patch(instance, None),
            device_id,
            now_ms,
        )?;
    } else {
        let remote = json!({ "startAt": instance.start_at, "isAllDay": instance.is_all_day });
        super::google::apply_remote_fields(conn, target, &remote, zone, device_id, now_ms)?;
        // `applyProviderWriteback`: in `broad` or `time_and_text` the item takes the text too.
        let mode: Option<String> = conn
            .query_row(
                "SELECT writeback_mode FROM calendar_bindings WHERE id = ?1",
                [&binding.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(failed)?;
        if matches!(mode.as_deref(), Some("broad" | "time_and_text")) {
            write_text(conn, target, instance, device_id, now_ms)?;
        }
    }
    if let Some(mut input) = super::upsert_input(conn, target, zone, zone_id, named)? {
        input["caldavRaw"] = json!(object.data);
        let written = bindings::Written {
            calendar_id: calendar_url.to_owned(),
            event_id: binding.remote_event_id.clone(),
            etag: object.etag.clone(),
        };
        bindings::record_push(conn, CALDAV, target, &written, input, device_id, now_ms)?;
    }
    // The fields just written queued the item as a local change; it is the server's.
    super::dequeue(conn, target)
}

/// `applyProviderWriteback`'s text fields per kind: a task's title and description, a
/// reminder's title and note, an inbox snooze's title and content. Server text is written as it
/// is, past the user-input rules of `reminders::update` (length caps) and `inbox::write::update`
/// (non-blank title): a refusal would fail the calendar's pull on every pass.
fn write_text(
    conn: &Connection,
    target: &Target,
    instance: &IcalInstance,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let (id, title) = (target.source_id.as_str(), instance.title.as_str());
    let text = instance.description.as_deref();
    let text_value = || Change::Set(text.map_or(Value::Null, Value::from));
    match target.source_type.as_str() {
        "task" => {
            crate::domain::tasks::set_title(conn, id, title, device_id, now_ms)?;
            crate::domain::tasks::set_description(conn, id, text, device_id, now_ms)?;
        }
        "reminder" => {
            let changes = vec![("title", Change::set(title)), ("note", text_value())];
            crate::domain::reminders::edit(conn, id, changes, device_id, now_ms)?.acknowledge();
        }
        "inbox_snooze" => {
            let changes = vec![("title", Change::set(title)), ("content", text_value())];
            crate::domain::inbox::write::edit(conn, id, changes, device_id, now_ms)?.acknowledge();
        }
        _ => {}
    }
    Ok(())
}
