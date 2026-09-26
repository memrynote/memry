//! Subscribed calendars (spec 007 CL073, desktop `ics/ics-subscriptions.ts`
//! and `ics-feed.ts`). The source row is a synced record, so a subscription
//! shows on every device; the events are this device's own mirror
//! (`calendar_local_events`), written from the feed it fetched, never
//! enqueued. The shell does the HTTP (Constitution I); the core parses,
//! expands, mirrors and keeps the per-device fetch state.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Map, Value, json};

use crate::api::errors::StorageError;
use crate::domain::notes::{failed, insert_local, iso, next_clock};
use crate::storage::repositories::{Change, sync_items};
use crate::sync::outbox;

use super::SOURCE_TYPE;
use super::colors::calendar_color_hex;
use super::ical::{IcalFeed, IcalInstance, IcalWindow};
use super::ics_url::host;
pub use super::ics_url::{normalize_url, source_id};
use super::write::live_payload;

pub const PROVIDER: &str = "ics";
const DAY_MS: i64 = 86_400_000;
/// Same span the Google mirror pulls on its first sync.
const WINDOW_PAST_MS: i64 = 90 * DAY_MS;
const WINDOW_FUTURE_MS: i64 = 365 * DAY_MS;
const DEFAULT_REFRESH_MS: i64 = 3_600_000;
const MIN_REFRESH_MS: i64 = 15 * 60_000;
const MAX_REFRESH_MS: i64 = DAY_MS;

/// `expansionWindow(now)`.
pub fn window(now_ms: i64) -> IcalWindow {
    IcalWindow {
        start_ms: now_ms - WINDOW_PAST_MS,
        end_ms: now_ms + WINDOW_FUTURE_MS,
    }
}

/// `clampRefreshInterval`.
pub fn clamp_refresh(hint_ms: Option<i64>) -> i64 {
    match hint_ms {
        Some(ms) if ms > 0 => ms.clamp(MIN_REFRESH_MS, MAX_REFRESH_MS),
        _ => DEFAULT_REFRESH_MS,
    }
}

/// What this device last saw from one feed.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedState {
    pub source_id: String,
    pub sync_status: String,
    pub last_synced_at: Option<String>,
    pub last_error: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub next_refresh_ms: Option<i64>,
    pub event_count: i64,
    pub first_start_at: Option<String>,
    pub last_start_at: Option<String>,
}

/// A 200 response's validators.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Validators {
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

/// `subscribeIcsCalendar` once the shell fetched and the core parsed: the
/// synced source row (created, or an archived one restored) and the mirror.
pub fn subscribe(
    conn: &Connection,
    url: &str,
    title: Option<&str>,
    feed: &IcalFeed,
    validators: &Validators,
    device_id: &str,
    now_ms: i64,
) -> Result<String, StorageError> {
    let id = source_id(url);
    let existing = live_payload(conn, SOURCE_TYPE, &id)?;
    if existing
        .as_ref()
        .is_some_and(|s| s.get("archivedAt").is_some_and(|a| !a.is_null()))
        || existing.is_none()
    {
        let at = iso(now_ms)?;
        let name = title
            .filter(|t| !t.trim().is_empty())
            .map(str::to_owned)
            .or_else(|| feed.name.clone())
            .unwrap_or_else(|| host(url));
        let tx = conn.unchecked_transaction().map_err(failed)?;
        match &existing {
            None => {
                let payload = crate::domain::notes::object(json!({
                    "id": id,
                    "provider": PROVIDER,
                    "kind": "calendar",
                    "accountId": null,
                    "remoteId": url,
                    "title": name,
                    "timezone": feed.timezone,
                    "color": null,
                    "isPrimary": false,
                    "isSelected": true,
                    "isMemryManaged": false,
                    "syncCursor": null,
                    "syncStatus": "ok",
                    "lastSyncedAt": at,
                    "metadata": null,
                    "archivedAt": null,
                    "clock": next_clock(&Map::new(), device_id)?,
                    "createdAt": at,
                    "modifiedAt": at,
                }));
                insert_local(&tx, SOURCE_TYPE, &id, payload, now_ms)?;
            }
            Some(stored) => {
                let changes = vec![
                    ("title", Change::Set(json!(name))),
                    ("timezone", Change::Set(json!(feed.timezone))),
                    ("isSelected", Change::Set(json!(true))),
                    ("syncStatus", Change::Set(json!("ok"))),
                    ("lastSyncedAt", Change::Set(json!(at))),
                    ("archivedAt", Change::Set(Value::Null)),
                    ("modifiedAt", Change::Set(json!(at))),
                    ("clock", Change::Set(next_clock(stored, device_id)?)),
                ];
                sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, &id, &changes, now_ms)?;
            }
        }
        outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, &id), now_ms)?;
        tx.commit().map_err(failed)?;
    }
    record_fetch(conn, &id, Ok((feed, validators)), now_ms)?;
    Ok(id)
}

/// `applyFeed`: the mirror equals the feed inside the window; rows that
/// ended before the window stay (history the feed may have pruned).
fn apply_feed(
    tx: &Connection,
    source_id: &str,
    events: &[IcalInstance],
    window: IcalWindow,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let window_start = super::projection::iso(window.start_ms);
    let mut existing: std::collections::HashMap<String, (String, Option<String>)> =
        std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT id, start_at, end_at FROM calendar_local_events WHERE source_id = ?1")
            .map_err(failed)?;
        let rows = stmt
            .query_map([source_id], |row| {
                Ok((row.get::<_, String>(0)?, (row.get(1)?, row.get(2)?)))
            })
            .map_err(failed)?;
        for row in rows {
            let (id, span) = row.map_err(failed)?;
            existing.insert(id, span);
        }
    }
    let mut seen = std::collections::HashSet::new();
    let mut changed = 0;
    for event in events {
        let id = format!(
            "calendar_external_event:{source_id}:{}",
            event.remote_event_id
        );
        if !seen.insert(id.clone()) {
            continue;
        }
        let written = tx
            .execute(
                "INSERT INTO calendar_local_events (id, source_id, remote_event_id, title, description,
                   location, start_at, end_at, timezone, is_all_day, status, raw_payload, modified_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description,
                   location = excluded.location, start_at = excluded.start_at, end_at = excluded.end_at,
                   timezone = excluded.timezone, is_all_day = excluded.is_all_day, status = excluded.status,
                   raw_payload = excluded.raw_payload, modified_at = excluded.modified_at
                 WHERE calendar_local_events.title IS NOT excluded.title
                   OR calendar_local_events.description IS NOT excluded.description
                   OR calendar_local_events.location IS NOT excluded.location
                   OR calendar_local_events.start_at IS NOT excluded.start_at
                   OR calendar_local_events.end_at IS NOT excluded.end_at
                   OR calendar_local_events.timezone IS NOT excluded.timezone
                   OR calendar_local_events.is_all_day IS NOT excluded.is_all_day
                   OR calendar_local_events.status IS NOT excluded.status
                   OR calendar_local_events.raw_payload IS NOT excluded.raw_payload",
                params![
                    id,
                    source_id,
                    event.remote_event_id,
                    event.title,
                    event.description,
                    event.location,
                    event.start_at,
                    event.end_at,
                    event.timezone,
                    event.is_all_day,
                    event.status,
                    event.remote_updated_at.as_ref().map(|at| json!({ "remoteUpdatedAt": at }).to_string()),
                    now_ms,
                ],
            )
            .map_err(failed)?;
        changed += written;
    }
    for (id, (start, end)) in existing {
        if seen.contains(&id) || end.as_deref().unwrap_or(&start) < window_start.as_str() {
            continue;
        }
        tx.execute("DELETE FROM calendar_local_events WHERE id = ?1", [&id])
            .map_err(failed)?;
        changed += 1;
    }
    Ok(changed)
}

/// A fetch outcome: the parsed feed and its validators, `Ok(None)` for a 304,
/// or the failure's code.
pub type Outcome<'a> = Result<(&'a IcalFeed, &'a Validators), &'a str>;

/// `recordFetchOutcome` + the mirror write + the next refresh time.
pub fn record_fetch(
    conn: &Connection,
    source_id: &str,
    outcome: Outcome<'_>,
    now_ms: i64,
) -> Result<usize, StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let previous = state_row(&tx, source_id)?;
    let changed = match outcome {
        Ok((feed, validators)) => {
            let refresh = clamp_refresh(feed.refresh_interval_ms);
            let changed = apply_feed(&tx, source_id, &feed.events, window(now_ms), now_ms)?;
            write_state(
                &tx,
                source_id,
                "ok",
                Some(&iso(now_ms)?),
                None,
                validators,
                refresh,
                now_ms + refresh,
            )?;
            changed
        }
        Err(code) => {
            let validators = Validators {
                etag: previous.as_ref().and_then(|p| p.etag.clone()),
                last_modified: previous.as_ref().and_then(|p| p.last_modified.clone()),
            };
            let refresh = previous
                .as_ref()
                .and_then(|p| p.refresh_ms)
                .unwrap_or(DEFAULT_REFRESH_MS);
            let synced = previous.as_ref().and_then(|p| p.last_synced_at.clone());
            write_state(
                &tx,
                source_id,
                "error",
                synced.as_deref(),
                Some(code),
                &validators,
                refresh,
                now_ms + MIN_REFRESH_MS,
            )?;
            0
        }
    };
    tx.commit().map_err(failed)?;
    Ok(changed)
}

/// A 304: nothing changed; the state says so and schedules the next fetch.
pub fn record_not_modified(
    conn: &Connection,
    source_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let previous = state_row(conn, source_id)?;
    let refresh = previous
        .as_ref()
        .and_then(|p| p.refresh_ms)
        .unwrap_or(DEFAULT_REFRESH_MS);
    let validators = Validators {
        etag: previous.as_ref().and_then(|p| p.etag.clone()),
        last_modified: previous.as_ref().and_then(|p| p.last_modified.clone()),
    };
    write_state(
        conn,
        source_id,
        "ok",
        Some(&iso(now_ms)?),
        None,
        &validators,
        refresh,
        now_ms + refresh,
    )
}

struct StateRow {
    last_synced_at: Option<String>,
    etag: Option<String>,
    last_modified: Option<String>,
    refresh_ms: Option<i64>,
}

fn state_row(conn: &Connection, source_id: &str) -> Result<Option<StateRow>, StorageError> {
    conn.query_row(
        "SELECT last_synced_at, etag, last_modified, refresh_ms FROM calendar_source_states WHERE source_id = ?1",
        [source_id],
        |row| {
            Ok(StateRow {
                last_synced_at: row.get(0)?,
                etag: row.get(1)?,
                last_modified: row.get(2)?,
                refresh_ms: row.get(3)?,
            })
        },
    )
    .optional()
    .map_err(failed)
}

#[allow(clippy::too_many_arguments)]
fn write_state(
    conn: &Connection,
    source_id: &str,
    status: &str,
    synced_at: Option<&str>,
    error: Option<&str>,
    validators: &Validators,
    refresh_ms: i64,
    next_ms: i64,
) -> Result<(), StorageError> {
    conn.execute(
        "INSERT INTO calendar_source_states (source_id, sync_status, last_synced_at, last_error, etag,
           last_modified, refresh_ms, next_refresh_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(source_id) DO UPDATE SET sync_status = excluded.sync_status,
           last_synced_at = excluded.last_synced_at, last_error = excluded.last_error, etag = excluded.etag,
           last_modified = excluded.last_modified, refresh_ms = excluded.refresh_ms,
           next_refresh_ms = excluded.next_refresh_ms",
        params![source_id, status, synced_at, error, validators.etag, validators.last_modified, refresh_ms, next_ms],
    )
    .map_err(failed)?;
    Ok(())
}

/// `updateIcsCalendar`: a synced rename / recolour.
pub fn update(
    conn: &Connection,
    source_id: &str,
    title: Option<&str>,
    color: Option<&str>,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    let Some(stored) = live_payload(&tx, SOURCE_TYPE, source_id)?
        .filter(|s| s.get("provider").and_then(Value::as_str) == Some(PROVIDER))
    else {
        return Err(StorageError::NotFound {
            what: format!("no subscribed calendar {source_id}"),
        });
    };
    let current_title = stored
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    let current_color = stored
        .get("color")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let next_title = title.map_or(current_title.clone(), str::to_owned);
    let next_color = match color {
        Some(name) => Some(
            calendar_color_hex(name)
                .ok_or_else(|| StorageError::Invalid {
                    what: format!("unknown colour {name}"),
                })?
                .to_owned(),
        ),
        None => current_color.clone(),
    };
    if next_title == current_title && next_color == current_color {
        return Ok(());
    }
    let changes = vec![
        ("title", Change::Set(json!(next_title))),
        ("color", Change::Set(json!(next_color))),
        ("modifiedAt", Change::Set(json!(iso(now_ms)?))),
        ("clock", Change::Set(next_clock(&stored, device_id)?)),
    ];
    sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, source_id, &changes, now_ms)?;
    outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, source_id), now_ms)?;
    tx.commit().map_err(failed)
}

/// `unsubscribeIcsCalendar`: the synced tombstone (`archivedAt`) and this
/// device's mirror and state dropped.
pub fn unsubscribe(
    conn: &Connection,
    source_id: &str,
    device_id: &str,
    now_ms: i64,
) -> Result<(), StorageError> {
    let tx = conn.unchecked_transaction().map_err(failed)?;
    if let Some(stored) = live_payload(&tx, SOURCE_TYPE, source_id)?
        && stored.get("archivedAt").is_none_or(Value::is_null)
    {
        let at = iso(now_ms)?;
        let changes = vec![
            ("archivedAt", Change::Set(json!(at))),
            ("modifiedAt", Change::Set(json!(at))),
            ("clock", Change::Set(next_clock(&stored, device_id)?)),
        ];
        sync_items::apply_local_edit_in(&tx, SOURCE_TYPE, source_id, &changes, now_ms)?;
        outbox::enqueue(&tx, &outbox::Change::upsert(SOURCE_TYPE, source_id), now_ms)?;
    }
    purge(&tx, source_id)?;
    tx.commit().map_err(failed)
}

fn purge(conn: &Connection, source_id: &str) -> Result<(), StorageError> {
    conn.execute(
        "DELETE FROM calendar_local_events WHERE source_id = ?1",
        [source_id],
    )
    .map_err(failed)?;
    conn.execute(
        "DELETE FROM calendar_source_states WHERE source_id = ?1",
        [source_id],
    )
    .map_err(failed)?;
    Ok(())
}

/// A feed due for a fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Due {
    pub source_id: String,
    pub url: String,
    pub validators: Validators,
}

/// `refreshDueIcsCalendars`' first half: removed or hidden sources lose
/// their mirror; the visible ones whose refresh time passed are due.
pub fn due(conn: &Connection, now_ms: i64, force: bool) -> Result<Vec<Due>, StorageError> {
    let sources: Vec<(String, String, bool, bool)> = {
        let mut stmt = conn
            .prepare(
                "SELECT id, remote_id, archived_at IS NOT NULL, is_selected FROM calendar_sources
                 WHERE provider = ?1 AND deleted_at IS NULL",
            )
            .map_err(failed)?;
        stmt.query_map([PROVIDER], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)?
    };
    let mut out = Vec::new();
    for (id, url, archived, selected) in sources {
        if archived || !selected {
            purge(conn, &id)?;
            continue;
        }
        let state = conn
            .query_row(
                "SELECT next_refresh_ms, etag, last_modified FROM calendar_source_states WHERE source_id = ?1",
                [&id],
                |row| Ok((row.get::<_, Option<i64>>(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(failed)?;
        if !force
            && state
                .as_ref()
                .and_then(|s| s.0)
                .is_some_and(|next| next > now_ms)
        {
            continue;
        }
        let (etag, last_modified) = state.map(|s| (s.1, s.2)).unwrap_or_default();
        out.push(Due {
            source_id: id,
            url,
            validators: Validators {
                etag,
                last_modified,
            },
        });
    }
    Ok(out)
}

/// Every subscription's device state and mirror summary
/// (`summarizeIcsCalendarEvents`).
pub fn states(conn: &Connection) -> Result<Vec<FeedState>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT s.id, COALESCE(st.sync_status, 'idle'), st.last_synced_at, st.last_error, st.etag,
               st.last_modified, st.next_refresh_ms,
               (SELECT COUNT(*) FROM calendar_local_events e WHERE e.source_id = s.id),
               (SELECT MIN(start_at) FROM calendar_local_events e WHERE e.source_id = s.id),
               (SELECT MAX(start_at) FROM calendar_local_events e WHERE e.source_id = s.id)
             FROM calendar_sources s LEFT JOIN calendar_source_states st ON st.source_id = s.id
             WHERE s.provider = ?1 AND s.deleted_at IS NULL AND s.archived_at IS NULL",
        )
        .map_err(failed)?;
    stmt.query_map([PROVIDER], |row| {
        Ok(FeedState {
            source_id: row.get(0)?,
            sync_status: row.get(1)?,
            last_synced_at: row.get(2)?,
            last_error: row.get(3)?,
            etag: row.get(4)?,
            last_modified: row.get(5)?,
            next_refresh_ms: row.get(6)?,
            event_count: row.get(7)?,
            first_start_at: row.get(8)?,
            last_start_at: row.get(9)?,
        })
    })
    .map_err(failed)?
    .collect::<Result<_, _>>()
    .map_err(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refresh_hints_clamp() {
        assert_eq!(clamp_refresh(None), DEFAULT_REFRESH_MS);
        assert_eq!(clamp_refresh(Some(60_000)), MIN_REFRESH_MS);
        assert_eq!(clamp_refresh(Some(10 * DAY_MS)), MAX_REFRESH_MS);
        assert_eq!(clamp_refresh(Some(4 * 3_600_000)), 4 * 3_600_000);
    }
}
