//! CalDAV on the phone (spec 007 CL074, desktop `caldav/caldav-accounts.ts`,
//! `caldav-connect.ts`, `caldav-mirror.ts`, `caldav-sync.ts`): the ids every
//! device derives the same way, connect / disconnect as synced source rows,
//! and a pull applied as synced mirror rows (one CalDAV object = one href,
//! its instances keyed `<href>` or `<href>::<recurrence-id>`), with objects
//! Memry wrote flowing back into their items instead.

use std::collections::HashMap;

use rusqlite::Connection;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::bindings;
use super::{CALDAV, Target};
use crate::api::calendar_records::CalendarZone;
use crate::api::errors::StorageError;
use crate::domain::calendar_items::ical::{
    IcalInstance, IcalWindow, IcalZones, expand_calendar_events, parse::parse_calendar,
};
use crate::domain::calendar_items::ics_url::normalize_url as normalize_feed_url;
use crate::domain::calendar_items::selection::purge_mirrors;
use crate::domain::calendar_items::write::live_payload;
use crate::domain::calendar_items::zone::LocalZone;
use crate::domain::calendar_items::{EXTERNAL_TYPE, SOURCE_TYPE};
use crate::domain::notes::{failed, insert_local, iso, next_clock, tombstone_local};
use crate::storage::repositories::instants;
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

/// `normalizeCaldavServerUrl`: `https://` added when missing, no query or
/// fragment, a trailing slash.
pub fn normalize_server_url(input: &str) -> Option<String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return None;
    }
    let has_scheme = trimmed.split_once("://").is_some_and(|(scheme, _)| {
        scheme
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "+.-".contains(c))
    });
    let with_scheme = if has_scheme {
        trimmed.to_owned()
    } else {
        format!("https://{trimmed}")
    };
    let normalized = normalize_feed_url(&with_scheme)?;
    let without_query = normalized
        .split('?')
        .next()
        .unwrap_or(&normalized)
        .to_owned();
    Some(if without_query.ends_with('/') {
        without_query
    } else {
        format!("{without_query}/")
    })
}

/// `caldavAccountId`.
pub fn account_id(server_url: &str, username: &str) -> String {
    let digest = hex::encode(Sha256::digest(
        format!("{server_url}\n{}", username.trim().to_lowercase()).as_bytes(),
    ));
    format!("caldav-{}", &digest[..24])
}

/// `caldavAccountSourceId`.
pub fn account_source_id(account_id: &str) -> String {
    format!("caldav-account:{account_id}")
}

/// `caldavCalendarSourceId`.
pub fn calendar_source_id(collection_url: &str) -> String {
    let digest = hex::encode(Sha256::digest(collection_url.as_bytes()));
    format!("caldav-calendar:{}", &digest[..32])
}

/// One calendar discovery found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveredCalendar {
    pub url: String,
    pub display_name: String,
    pub color: Option<String>,
    pub timezone: Option<String>,
    pub supports_sync_collection: bool,
}

/// What `discoverCaldavAccount` found, plus the form's input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connect {
    pub server_url: String,
    pub username: String,
    pub principal_url: String,
    pub home_url: String,
    pub preset: Option<String>,
    pub calendars: Vec<DiscoveredCalendar>,
    /// Collection URLs to show; `None` = every calendar.
    pub selected: Option<Vec<String>>,
}

fn upsert_source(
    tx: &Connection,
    id: &str,
    fields: Value,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let at = iso(now_ms)?;
    match live_payload(tx, SOURCE_TYPE, id)? {
        Some(stored) => {
            let mut changes: Vec<(&str, Change)> = fields
                .as_object()
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.as_str(), Change::Set(v.clone())))
                .collect();
            changes.push(("modifiedAt", Change::Set(json!(at))));
            changes.push(("clock", Change::Set(next_clock(&stored, device_id)?)));
            sync_items::apply_local_edit_in(tx, SOURCE_TYPE, id, &changes, now_ms)?;
        }
        None => {
            let mut payload = fields.as_object().cloned().unwrap_or_default();
            payload.insert("id".into(), json!(id));
            payload.insert("createdAt".into(), json!(at));
            payload.insert("modifiedAt".into(), json!(at));
            payload.insert("clock".into(), next_clock(&Map::new(), device_id)?);
            insert_local(tx, SOURCE_TYPE, id, payload, now_ms)?;
        }
    }
    outbox::enqueue(tx, &outbox::Change::upsert(SOURCE_TYPE, id), now_ms)?;
    Ok(())
}

/// `connectCaldavAccount` after discovery (the shell stores the password):
/// one synced `account` row, one `calendar` row per collection, calendars
/// the server no longer lists archived. Returns the account id.
pub fn connect(
    conn: &Connection,
    input: &Connect,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let username = input.username.trim().to_owned();
    let account = account_id(&input.server_url, &username);
    let at = iso(now_ms)?;
    let tx = conn.unchecked_transaction().map_err(failed)?;
    upsert_source(
        &tx,
        &account_source_id(&account),
        json!({
            "provider": CALDAV, "kind": "account", "accountId": account, "remoteId": input.principal_url,
            "title": username, "timezone": null, "color": null, "isPrimary": false, "isSelected": false,
            "isMemryManaged": false, "syncStatus": "ok", "lastSyncedAt": at, "archivedAt": null,
            "metadata": {
                "connectedVia": "basic", "email": username, "serverUrl": input.server_url, "username": username,
                "principalUrl": input.principal_url, "homeUrl": input.home_url, "preset": input.preset,
            },
        }),
        device_id,
        now_ms,
    )?;
    let mut discovered = Vec::new();
    for calendar in &input.calendars {
        let id = calendar_source_id(&calendar.url);
        discovered.push(id.clone());
        let existing = live_payload(&tx, SOURCE_TYPE, &id)?;
        let was_archived = existing
            .as_ref()
            .is_some_and(|s| !s.get("archivedAt").unwrap_or(&Value::Null).is_null());
        let selected = match &input.selected {
            Some(chosen) => chosen.contains(&calendar.url),
            None => existing
                .as_ref()
                .and_then(|s| s.get("isSelected"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
        };
        let cursor = if was_archived {
            Value::Null
        } else {
            existing
                .as_ref()
                .and_then(|s| s.get("syncCursor"))
                .cloned()
                .unwrap_or(Value::Null)
        };
        let status = existing
            .as_ref()
            .and_then(|s| s.get("syncStatus"))
            .cloned()
            .unwrap_or(json!("pending"));
        upsert_source(
            &tx,
            &id,
            json!({
                "provider": CALDAV, "kind": "calendar", "accountId": account, "remoteId": calendar.url,
                "title": calendar.display_name, "timezone": calendar.timezone, "color": calendar.color,
                "isPrimary": false, "isSelected": selected, "isMemryManaged": false, "syncCursor": cursor,
                "syncStatus": status, "metadata": { "supportsSyncCollection": calendar.supports_sync_collection },
                "archivedAt": null,
            }),
            device_id,
            now_ms,
        )?;
    }
    let vanished = account_calendars(&tx, &account)?
        .into_iter()
        .filter(|(id, _)| !discovered.contains(id))
        .collect::<Vec<_>>();
    archive(&tx, &vanished, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    Ok(account)
}

fn account_calendars(
    conn: &Connection,
    account: &str,
) -> Result<Vec<(String, String)>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, remote_id FROM calendar_sources WHERE provider = 'caldav' AND account_id = ?1
               AND kind = 'calendar' AND archived_at IS NULL AND deleted_at IS NULL",
        )
        .map_err(failed)?;
    stmt.query_map([account], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}

fn archive(
    tx: &Connection,
    sources: &[(String, String)],
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let at = iso(now_ms)?;
    for (id, remote) in sources {
        purge_mirrors(tx, CALDAV, id, remote, device_id, now_ms)?;
        if let Some(stored) = live_payload(tx, SOURCE_TYPE, id)? {
            let changes = vec![
                ("archivedAt", Change::Set(json!(at))),
                ("modifiedAt", Change::Set(json!(at))),
                ("clock", Change::Set(next_clock(&stored, device_id)?)),
            ];
            sync_items::apply_local_edit_in(tx, SOURCE_TYPE, id, &changes, now_ms)?;
            outbox::enqueue(tx, &outbox::Change::upsert(SOURCE_TYPE, id), now_ms)?;
        }
    }
    Ok(())
}

/// `disconnectCaldavAccount`: mirrors gone, every row of the account
/// tombstoned (the shell forgets the password).
pub fn disconnect(
    conn: &Connection,
    account: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let mut sources = account_calendars(&tx, account)?;
    sources.push((account_source_id(account), String::new()));
    archive(&tx, &sources, device_id, now_ms)?;
    tx.commit().map_err(failed)
}

/// One object as the server answered it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Object {
    pub href: String,
    pub etag: Option<String>,
    pub data: String,
}

/// `(id, remote_event_id, start_at, end_at)` of a mirrored row.
type MirrorRow = (String, String, String, Option<String>);

fn href_of(remote_event_id: &str) -> &str {
    remote_event_id
        .split("::")
        .next()
        .unwrap_or(remote_event_id)
}

fn object_rows(conn: &Connection, source_id: &str) -> Result<Vec<MirrorRow>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT id, remote_event_id, start_at, end_at FROM calendar_external_events
              WHERE source_id = ?1 AND deleted_at IS NULL",
        )
        .map_err(failed)?;
    stmt.query_map([source_id], |row| {
        Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

fn delete_rows(
    tx: &Connection,
    ids: &[String],
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    for id in ids {
        tombstone_local(tx, EXTERNAL_TYPE, id, device_id, now_ms)?;
        outbox::enqueue(tx, &outbox::Change::delete(EXTERNAL_TYPE, id), now_ms)?;
    }
    Ok(ids.len())
}

/// `replaceObjectInstances`: one object's rows equal its instances.
fn replace_object(
    tx: &Connection,
    source_id: &str,
    object: &Object,
    instances: &[IcalInstance],
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let at = iso(now_ms)?;
    let existing: Vec<String> = object_rows(tx, source_id)?
        .into_iter()
        .filter(|(_, remote, _, _)| href_of(remote) == object.href)
        .map(|(id, _, _, _)| id)
        .collect();
    let mut ordered: Vec<&IcalInstance> = instances.iter().collect();
    ordered.sort_by(|a, b| a.start_at.cmp(&b.start_at));
    let mut seen = Vec::new();
    let mut changed = 0;
    for (index, instance) in ordered.into_iter().enumerate() {
        let id = format!(
            "calendar_external_event:{source_id}:{}",
            instance.remote_event_id
        );
        if seen.contains(&id) {
            continue;
        }
        seen.push(id.clone());
        let mut raw = json!({ "href": object.href, "etag": object.etag });
        if index == 0 {
            raw["ical"] = json!(object.data);
        }
        let fields = json!({
            "sourceId": source_id, "remoteEventId": instance.remote_event_id, "remoteEtag": object.etag,
            "remoteUpdatedAt": instance.remote_updated_at, "title": instance.title,
            "description": instance.description, "location": instance.location, "startAt": instance.start_at,
            "endAt": instance.end_at, "timezone": instance.timezone, "isAllDay": instance.is_all_day,
            "status": instance.status, "recurrenceRule": null, "attendees": null, "reminders": null,
            "visibility": null, "colorId": null, "conferenceData": null, "rawPayload": raw, "archivedAt": null,
        });
        match live_payload(tx, EXTERNAL_TYPE, &id)? {
            Some(stored) => {
                if fields.as_object().is_some_and(|f| {
                    f.iter()
                        .all(|(k, v)| stored.get(k).unwrap_or(&Value::Null) == v)
                }) {
                    continue;
                }
                let mut changes: Vec<(&str, Change)> = fields
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(k, v)| (k.as_str(), Change::Set(v.clone())))
                    .collect();
                changes.push(("modifiedAt", Change::Set(json!(at))));
                changes.push(("clock", Change::Set(next_clock(&stored, device_id)?)));
                sync_items::apply_local_edit_in(tx, EXTERNAL_TYPE, &id, &changes, now_ms)?;
            }
            None => {
                let mut payload = fields.as_object().cloned().unwrap_or_default();
                payload.insert("id".into(), json!(id));
                payload.insert("createdAt".into(), json!(at));
                payload.insert("modifiedAt".into(), json!(at));
                payload.insert("clock".into(), next_clock(&Map::new(), device_id)?);
                insert_local(tx, EXTERNAL_TYPE, &id, payload, now_ms)?;
            }
        }
        outbox::enqueue(tx, &outbox::Change::upsert(EXTERNAL_TYPE, &id), now_ms)?;
        changed += 1;
    }
    let removed: Vec<String> = existing
        .into_iter()
        .filter(|id| !seen.contains(id))
        .collect();
    Ok(changed + delete_rows(tx, &removed, device_id, now_ms)?)
}

/// A pull's answer: objects changed or new, hrefs deleted, whether this was
/// a full window listing (so unseen objects are gone), the next cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pull {
    pub objects: Vec<Object>,
    pub removed: Vec<String>,
    pub full: bool,
    pub cursor: Option<String>,
}

/// `syncCaldavSource` after the requests. Objects Memry wrote (a binding on
/// their href) flow back into their items; the rest mirror.
#[allow(clippy::too_many_arguments)]
pub fn apply_pull(
    conn: &Connection,
    source_id: &str,
    calendar_url: &str,
    pull: &Pull,
    window: IcalWindow,
    zones: &IcalZones,
    device_zone: &dyn LocalZone,
    zone_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let mut changed = 0;
    let mut seen: Vec<String> = Vec::new();
    for object in &pull.objects {
        seen.push(object.href.clone());
        let href = object.href.clone();
        let key = move |_uid: &str, rid: Option<&str>| {
            rid.map_or_else(|| href.clone(), |rid| format!("{href}::{rid}"))
        };
        let Ok(root) = parse_calendar(&object.data) else {
            continue;
        };
        let instances = expand_calendar_events(
            &root,
            window,
            root.text("X-WR-TIMEZONE").as_deref(),
            &key,
            zones,
        );
        // Objects a Memry item is bound to flow back into that item; only the
        // unbound rest of a series mirrors (`applyBoundCaldavObject`).
        let bound = bindings::for_object(conn, calendar_url, &object.href)?;
        let mut whole = false;
        let mut handled: Vec<&str> = Vec::new();
        for (target, binding) in &bound {
            handled.push(&binding.remote_event_id);
            whole |= binding.remote_event_id == object.href;
            // Our own write, read back.
            if binding.remote_version.is_some() && binding.remote_version == object.etag {
                continue;
            }
            let (_, rid) = bindings::caldav_parts(&binding.remote_event_id);
            let instance = instances
                .iter()
                .find(|i| i.remote_event_id == binding.remote_event_id)
                .or_else(|| rid.is_none().then(|| instances.first()).flatten());
            match instance {
                Some(instance) => write_back(
                    conn,
                    target,
                    binding,
                    calendar_url,
                    object,
                    instance,
                    device_zone,
                    zone_id,
                    &zones.named,
                    device_id,
                    now_ms,
                )?,
                // An occurrence the series no longer produces (EXDATE, a
                // cancelled override) inside the window is gone; one outside
                // it is left for a later pull.
                None => {
                    let inside = rid
                        .and_then(instants::to_epoch_ms)
                        .is_some_and(|ms| ms >= window.start_ms && ms < window.end_ms);
                    if !inside {
                        continue;
                    }
                    super::apply_remote_delete(conn, target, &binding.id, device_id, now_ms)?;
                }
            }
            changed += 1;
        }
        if whole {
            continue;
        }
        let instances: Vec<IcalInstance> = instances
            .into_iter()
            .filter(|i| !handled.contains(&i.remote_event_id.as_str()))
            .collect();
        let tx = conn.unchecked_transaction().map_err(failed)?;
        changed += replace_object(&tx, source_id, object, &instances, device_id, now_ms)?;
        tx.commit().map_err(failed)?;
    }
    // A bound object deleted on the server deletes (or unschedules) its item.
    for href in &pull.removed {
        for (target, binding) in bindings::for_object(conn, calendar_url, href)? {
            super::apply_remote_delete(conn, &target, &binding.id, device_id, now_ms)?;
            changed += 1;
        }
    }
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let window_start = crate::domain::calendar_items::projection::iso(window.start_ms);
    let stale: Vec<String> = object_rows(&tx, source_id)?
        .into_iter()
        .filter(|(_, remote, start, end)| {
            let href = href_of(remote);
            let gone = pull.removed.iter().any(|r| r == href);
            let unseen = pull.full
                && !seen.iter().any(|s| s == href)
                && end.as_deref().unwrap_or(start) >= window_start.as_str();
            gone || unseen
        })
        .map(|(id, _, _, _)| id)
        .collect();
    changed += delete_rows(&tx, &stale, device_id, now_ms)?;
    tx.commit().map_err(failed)?;
    super::google::set_source_cursor(
        conn,
        source_id,
        pull.cursor.as_deref(),
        "ok",
        device_id,
        now_ms,
    )?;
    Ok(changed)
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
    super::dequeue(conn, target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_urls_normalise() {
        assert_eq!(
            normalize_server_url("caldav.fastmail.com").as_deref(),
            Some("https://caldav.fastmail.com/")
        );
        assert_eq!(
            normalize_server_url("https://dav.example.org/remote.php/dav?x=1#y").as_deref(),
            Some("https://dav.example.org/remote.php/dav/")
        );
        assert_eq!(normalize_server_url("  "), None);
        assert_eq!(normalize_server_url("ftp://x"), None);
    }

    #[test]
    fn ids_are_stable() {
        assert!(account_id("https://x/", " Agent@X ").starts_with("caldav-"));
        assert_eq!(
            account_id("https://x/", "agent@x"),
            account_id("https://x/", " AGENT@X ")
        );
        assert_eq!(
            calendar_source_id("https://x/cal/").len(),
            "caldav-calendar:".len() + 32
        );
    }
}
