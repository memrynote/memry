//! `SEARCH_EVENTS` (`ipc/calendar-handlers.ts`): memrynote events, and optionally imported
//! ones, whose title contains a query, nearest to now first. The relation and canvas pickers
//! read it; the calendar page's own search filters the range instead
//! ([`super::projection::search`]).

use rusqlite::{Connection, params};

use crate::api::errors::StorageError;
use crate::domain::notes::failed;
use crate::storage::repositories::instants;

/// `CalendarEventSearchItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventSearchHit {
    pub id: String,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub is_all_day: bool,
    /// `kind: 'external_event'` for an imported event; native events carry no kind.
    pub external: bool,
}

/// The handler's search: `searchCalendarEventsByTitle`, then with `include_external` the
/// imported events of selected calendars (`searchCalendarExternalEventsByTitle`), merged by
/// distance from `now` and cut to `limit`. `now` is an ISO instant, compared as a string the
/// way the handlers compare it.
pub fn search(
    conn: &Connection,
    query: &str,
    limit: usize,
    now: &str,
    include_external: bool,
) -> Result<Vec<EventSearchHit>, StorageError> {
    let needle = query.trim();
    if needle.is_empty() {
        return Ok(Vec::new());
    }
    let pattern = format!("%{needle}%");
    let now_ms = instants::to_epoch_ms(now).unwrap_or(0);
    let limit_sql = i64::try_from(limit).unwrap_or(i64::MAX);
    let mut events = native(conn, &pattern, now, now_ms, limit_sql)?;
    events.truncate(limit);
    if !include_external {
        return Ok(events);
    }
    events.extend(external(conn, &pattern, now, limit_sql)?);
    // `Math.abs(Date.parse(startAt) - now) || 0`: an unparsable start sorts first.
    let distance = |hit: &EventSearchHit| {
        instants::to_epoch_ms(&hit.start_at).map_or(0, |start| start.abs_diff(now_ms))
    };
    events.sort_by_key(distance);
    events.truncate(limit);
    Ok(events)
}

const HIT_COLUMNS: &str = "id, title, start_at, end_at, is_all_day";

fn hit(row: &rusqlite::Row<'_>, external: bool) -> rusqlite::Result<EventSearchHit> {
    Ok(EventSearchHit {
        id: row.get(0)?,
        title: row.get(1)?,
        start_at: row.get(2)?,
        end_at: row.get(3)?,
        is_all_day: row.get::<_, i64>(4)? != 0,
        external,
    })
}

/// `searchCalendarEventsByTitle`: the nearest `limit` upcoming and past matches, then by
/// distance from now; a start that does not parse sorts last.
fn native(
    conn: &Connection,
    pattern: &str,
    now: &str,
    now_ms: i64,
    limit: i64,
) -> Result<Vec<EventSearchHit>, StorageError> {
    let mut hits = Vec::new();
    for (side, order) in [(">=", "ASC"), ("<", "DESC")] {
        let sql = format!(
            "SELECT {HIT_COLUMNS} FROM calendar_events
              WHERE deleted_at IS NULL AND archived_at IS NULL
                AND ulower(title) LIKE ulower(?1) AND start_at {side} ?2
              ORDER BY start_at {order} LIMIT ?3"
        );
        let mut stmt = conn.prepare(&sql).map_err(failed)?;
        let rows = stmt
            .query_map(params![pattern, now, limit], |row| hit(row, false))
            .map_err(failed)?;
        for row in rows {
            hits.push(row.map_err(failed)?);
        }
    }
    hits.sort_by_key(|hit| {
        instants::to_epoch_ms(&hit.start_at).map_or(u64::MAX, |start| start.abs_diff(now_ms))
    });
    Ok(hits)
}

/// `searchCalendarExternalEventsByTitle`: live imported events of selected calendars.
fn external(
    conn: &Connection,
    pattern: &str,
    now: &str,
    limit: i64,
) -> Result<Vec<EventSearchHit>, StorageError> {
    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.title, e.start_at, e.end_at, e.is_all_day
               FROM calendar_external_events e
               JOIN calendar_sources s ON s.id = e.source_id
              WHERE e.deleted_at IS NULL AND e.archived_at IS NULL
                AND s.deleted_at IS NULL AND s.is_selected = 1
                AND ulower(e.title) LIKE ulower(?1)
              ORDER BY abs(julianday(e.start_at) - julianday(?2))
              LIMIT ?3",
        )
        .map_err(failed)?;
    stmt.query_map(params![pattern, now, limit], |row| hit(row, true))
        .map_err(failed)?
        .collect::<Result<_, _>>()
        .map_err(failed)
}
