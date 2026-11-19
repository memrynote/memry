//! A pulled CalDAV object Memry wrote flows back into the items bound to it
//! (`applyBoundCaldavObject`), unless a local change to the item is still
//! queued: the drain sends that change first, and its `If-Match` meets the
//! remote change as a conflict instead of the pull overwriting the edit.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::json;

use super::caldav::Object;
use super::{CALDAV, Target, bindings};
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::ical::parse::Component;
use crate::domain::calendar_items::ical::{
    IcalInstance, IcalWindow, IcalZones, expand_calendar_events,
};
use crate::domain::calendar_items::zone::LocalZone;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

const YEAR_MS: i64 = 366 * 24 * 60 * 60 * 1000;

/// What the bound items of one object took.
pub struct Bound {
    /// A binding holds the whole object, so none of it mirrors.
    pub whole: bool,
    /// The remote event ids the bindings hold.
    pub handled: Vec<String>,
    pub changed: usize,
}

fn queued(conn: &Connection, target: &Target) -> Result<bool, StorageError> {
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
        let mut instance = instances
            .iter()
            .find(|i| i.remote_event_id == binding.remote_event_id)
            .or_else(|| rid.is_none().then(|| instances.first()).flatten())
            .cloned();
        // A single event the server moved out of the window still moves its item; a series
        // there is left, as its occurrences are.
        if instance.is_none() && rid.is_none() && !object.data.contains("RRULE") {
            let href = object.href.clone();
            let key = move |_uid: &str, rid: Option<&str>| {
                rid.map_or_else(|| href.clone(), |rid| format!("{href}::{rid}"))
            };
            let wide = IcalWindow {
                start_ms: window.start_ms - 50 * YEAR_MS,
                end_ms: window.end_ms + 50 * YEAR_MS,
            };
            let calendar_zone = root.text("X-WR-TIMEZONE");
            instance = expand_calendar_events(root, wide, calendar_zone.as_deref(), &key, zones)
                .ok()
                .and_then(|all| all.into_iter().next());
        }
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
    let remote = json!({
        "title": instance.title, "description": instance.description, "location": instance.location,
        "startAt": instance.start_at, "endAt": instance.end_at, "timezone": instance.timezone,
        "isAllDay": instance.is_all_day,
    });
    super::google::apply_remote_fields(conn, target, &remote, zone, device_id, now_ms)?;
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
